// Package testdb gives each test package its own database on one shared
// Postgres, with all migrations applied, and resets data between tests.
//
// TEST_DATABASE_URL points at the server (`make test` uses the compose
// database; any database name on it works, it is only used to create and drop
// others). Without it, each package starts its own Postgres via Testcontainers.
// The migrations are applied once into a template database named after a hash
// of the migration files; every package copies it (CREATE DATABASE … TEMPLATE,
// much faster than migrating) and drops its copy when its tests end.
//
// Usage in a package:
//
//	func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }
//	func TestX(t *testing.T) { pool := testdb.Pool(t) ... }
package testdb

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/migrations"
)

var (
	pool *pgxpool.Pool
	// serverURL is the URL of the package's database, for NewDatabase.
	serverURL string
)

// lockKey serialises template creation and copying between test packages
// running in parallel against the same server.
const lockKey = 7_361_204_918

// Run creates the package's database, runs the package's tests and drops it.
func Run(m *testing.M) int {
	ctx := context.Background()

	adminURL := os.Getenv("TEST_DATABASE_URL")
	if adminURL == "" {
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
		adminURL, err = ctr.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			fmt.Fprintln(os.Stderr, "testdb: connection string:", err)
			return 1
		}
	}

	name, err := createPackageDatabase(ctx, adminURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	defer func() {
		if err := dropDatabase(context.Background(), adminURL, name); err != nil {
			fmt.Fprintln(os.Stderr, "testdb:", err)
		}
	}()

	serverURL, err = withDatabase(adminURL, name)
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	pool, err = database.Open(ctx, serverURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	defer pool.Close()

	return m.Run()
}

// createPackageDatabase copies the migrated template (creating it first if
// needed) into a new database for this package and returns its name.
func createPackageDatabase(ctx context.Context, adminURL string) (string, error) {
	template, err := templateName()
	if err != nil {
		return "", err
	}
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return "", fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	// A session lock: released when the connection closes, also on a crash.
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return "", fmt.Errorf("lock: %w", err)
	}

	var ready bool
	err = conn.QueryRow(ctx, "SELECT datistemplate FROM pg_database WHERE datname = $1", template).Scan(&ready)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("look up template: %w", err)
	}
	if !ready {
		// Missing, or left half-built by an interrupted run.
		if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+template+" WITH (FORCE)"); err != nil {
			return "", fmt.Errorf("drop template: %w", err)
		}
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+template); err != nil {
			return "", fmt.Errorf("create template: %w", err)
		}
		templateURL, err := withDatabase(adminURL, template)
		if err != nil {
			return "", err
		}
		if err := database.Migrate(ctx, templateURL); err != nil {
			return "", err
		}
		if _, err := conn.Exec(ctx, "ALTER DATABASE "+template+" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false"); err != nil {
			return "", fmt.Errorf("mark template: %w", err)
		}
	}

	name := "snapflow_test_" + randomSuffix()
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name+" TEMPLATE "+template); err != nil {
		return "", fmt.Errorf("create database from template: %w", err)
	}
	return name, nil
}

// templateName is the template database for the current migrations: a
// changed or added migration file gives a new template.
func templateName() (string, error) {
	h := sha256.New()
	err := fs.WalkDir(migrations.FS, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(migrations.FS, path)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(h, "%s\x00%d\x00", path, len(b))
		h.Write(b)
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash migrations: %w", err)
	}
	return "snapflow_test_template_" + hex.EncodeToString(h.Sum(nil))[:16], nil
}

func dropDatabase(ctx context.Context, adminURL, name string) error {
	conn, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
		return fmt.Errorf("drop database %s: %w", name, err)
	}
	return nil
}

func withDatabase(rawURL, name string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse url: %w", err)
	}
	u.Path = "/" + name
	return u.String(), nil
}

func randomSuffix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
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
	name := fmt.Sprintf("snapflow_scratch_%d_%d_%s", os.Getpid(), dbSeq.Add(1), randomSuffix())
	if _, err := pool.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("testdb: create database: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("testdb: drop database: %v", err)
		}
	})
	u, err := withDatabase(serverURL, name)
	if err != nil {
		t.Fatalf("testdb: %v", err)
	}
	return u
}
