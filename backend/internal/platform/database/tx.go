package database

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// TxAttempts is how often InTx runs a transaction that fails with a deadlock
// or serialization failure before it gives up.
const TxAttempts = 3

// Beginner starts transactions; *pgxpool.Pool implements it.
type Beginner interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// InTx runs fn in one transaction with opts; any error rolls it back. A
// transaction that Postgres aborts because of a deadlock (40P01) or a
// serialization failure (40001) is run again from the start, up to
// TxAttempts times with a short jittered pause; if it still fails, the
// caller gets 409 request.conflict_retry. fn must therefore only touch the
// database through tx and must be safe to run more than once.
func InTx(ctx context.Context, db Beginner, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	for attempt := 1; ; attempt++ {
		err := pgx.BeginTxFunc(ctx, db, opts, fn)
		if !apperr.IsRetryable(err) {
			return err
		}
		if attempt >= TxAttempts {
			slog.WarnContext(ctx, "database: transaction kept conflicting, giving up",
				"attempts", attempt, "request_id", apperr.RequestID(ctx), "error", err)
			return apperr.ConflictRetry()
		}
		// 5-15 ms, then 10-30 ms: enough for the other transaction to finish.
		pause := time.Duration(attempt) * (5*time.Millisecond + rand.N(10*time.Millisecond)) //nolint:gosec // jitter, not security
		select {
		case <-time.After(pause):
		case <-ctx.Done():
			return errors.Join(ctx.Err(), err)
		}
	}
}

// ReadOnlySnapshot is for reads that run several queries (a page and its
// total) and must see one consistent state.
var ReadOnlySnapshot = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
