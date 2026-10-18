// Package testdb starts a real Postgres for tests (via Testcontainers),
// applies all migrations and resets data between tests.
//
// Usage in a package:
//
//	func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }
//	func TestX(t *testing.T) { pool := testdb.Pool(t) ... }
package testdb

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

var pool *pgxpool.Pool

// Run starts the database, runs the package's tests and stops the database.
// Set TEST_DATABASE_URL to use an existing database instead of a container.
func Run(m *testing.M) int {
	ctx := context.Background()

	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		ctr, err := postgres.Run(ctx, "postgres:17-alpine",
			postgres.WithDatabase("snapflow_test"),
			postgres.WithUsername("snapflow"),
			postgres.WithPassword("snapflow"),
			testcontainers.WithWaitStrategy(
				wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second),
			),
		)
		if err != nil {
			fmt.Fprintln(os.Stderr, "testdb: start postgres:", err)
			return 1
		}
		defer func() { _ = ctr.Terminate(ctx) }()
		url, err = ctr.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			fmt.Fprintln(os.Stderr, "testdb: connection string:", err)
			return 1
		}
	}

	if err := database.Migrate(ctx, url); err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	var err error
	pool, err = database.Open(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	defer pool.Close()

	return m.Run()
}

// Pool returns the shared pool with all application tables emptied.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if pool == nil {
		t.Fatal("testdb: call testdb.Run from TestMain")
	}
	_, err := pool.Exec(context.Background(), `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename <> 'goose_db_version'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
  END LOOP;
END $$;`)
	if err != nil {
		t.Fatalf("testdb: reset: %v", err)
	}
	return pool
}
