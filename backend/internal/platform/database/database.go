// Package database opens the Postgres pool and applies migrations.
package database

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver for goose
	"github.com/pressly/goose/v3"

	"github.com/kingkill85/snapflow/backend/migrations"
)

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Migrate applies all pending migrations.
func Migrate(ctx context.Context, url string) error {
	return MigrateTo(ctx, url, 0)
}

// MigrateTo applies the pending migrations up to and including version (all of
// them for 0). Tests use it to put a database into an older shape.
func MigrateTo(ctx context.Context, url string, version int64) error {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer func() { _ = db.Close() }()

	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrations.FS)
	if err != nil {
		return fmt.Errorf("create migration provider: %w", err)
	}
	if version == 0 {
		_, err = provider.Up(ctx)
	} else {
		_, err = provider.UpTo(ctx, version)
	}
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}
