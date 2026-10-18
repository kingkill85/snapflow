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
// database through tx and must be safe to run more than once. On a Nested
// database fn runs once in a savepoint.
func InTx(ctx context.Context, db Beginner, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	if _, nested := db.(*Nested); nested {
		// A savepoint: run once, the outer transaction retries.
		return pgx.BeginTxFunc(ctx, db, opts, fn)
	}
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

// Nested is an open transaction used as the database of a service, so that
// the service's work joins the outer transaction (e.g. an import that writes
// through the products service). Its BeginTx starts a savepoint: a failing
// statement inside a service transaction (a unique violation, say) rolls back
// only to that savepoint and leaves the outer transaction usable. InTx does
// not retry on a Nested database: a deadlock or serialization failure aborts
// the outer transaction's snapshot, so the outer InTx must run again from the
// start.
type Nested struct {
	pgx.Tx
}

// NewNested wraps tx; see Nested.
func NewNested(tx pgx.Tx) *Nested { return &Nested{Tx: tx} }

// BeginTx starts a savepoint; opts are ignored (the outer transaction's
// isolation and access mode apply).
func (n *Nested) BeginTx(ctx context.Context, _ pgx.TxOptions) (pgx.Tx, error) {
	return n.Begin(ctx)
}
