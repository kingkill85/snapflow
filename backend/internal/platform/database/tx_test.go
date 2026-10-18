package database_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

type fakeTx struct{ pgx.Tx }

func (fakeTx) Commit(context.Context) error   { return nil }
func (fakeTx) Rollback(context.Context) error { return nil }

type fakeDB struct{ begun int }

func (d *fakeDB) BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error) {
	d.begun++
	return fakeTx{}, nil
}

func TestInTxRetries(t *testing.T) {
	ctx := context.Background()
	deadlock := &pgconn.PgError{Code: "40P01"}

	// Succeeds on the second run.
	db, runs := &fakeDB{}, 0
	err := database.InTx(ctx, db, pgx.TxOptions{}, func(pgx.Tx) error {
		runs++
		if runs == 1 {
			return deadlock
		}
		return nil
	})
	if err != nil || runs != 2 || db.begun != 2 {
		t.Errorf("retry: err %v, %d runs, %d transactions", err, runs, db.begun)
	}

	// Keeps failing: 409 request.conflict_retry after TxAttempts runs.
	db, runs = &fakeDB{}, 0
	err = database.InTx(ctx, db, pgx.TxOptions{}, func(pgx.Tx) error {
		runs++
		return &pgconn.PgError{Code: "40001"}
	})
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != 409 || ae.Code != "request.conflict_retry" || runs != database.TxAttempts {
		t.Errorf("give up: err %v, %d runs", err, runs)
	}

	// Other errors are returned at once.
	db, runs = &fakeDB{}, 0
	other := &pgconn.PgError{Code: "23505"}
	err = database.InTx(ctx, db, pgx.TxOptions{}, func(pgx.Tx) error { runs++; return other })
	if !errors.Is(err, other) || runs != 1 {
		t.Errorf("no retry: err %v, %d runs", err, runs)
	}
}
