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
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

var (
	pool *pgxpool.Pool
	// serverURL is the URL of the test database, for NewDatabase.
	serverURL string
)

// Run starts the database, runs the package's tests and stops the database.
// Set TEST_DATABASE_URL to use an existing database instead of a container.
func Run(m *testing.M) int {
	ctx := context.Background()

	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
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
		dbURL, err = ctr.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			fmt.Fprintln(os.Stderr, "testdb: connection string:", err)
			return 1
		}
	}

	serverURL = dbURL
	if err := database.Migrate(ctx, dbURL); err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	var err error
	pool, err = database.Open(ctx, dbURL)
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

var dbSeq atomic.Int64

// NewDatabase creates an empty database (no migrations applied) on the test
// server and returns its URL; it is dropped when the test ends. Migration
// tests use it to build a database in an older shape.
func NewDatabase(t *testing.T) string {
	t.Helper()
	if pool == nil {
		t.Fatal("testdb: call testdb.Run from TestMain")
	}
	ctx := context.Background()
	name := fmt.Sprintf("snapflow_scratch_%d_%d", os.Getpid(), dbSeq.Add(1))
	if _, err := pool.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("testdb: create database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("testdb: drop database: %v", err)
		}
	})
	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("testdb: parse url: %v", err)
	}
	u.Path = "/" + name
	return u.String()
}
