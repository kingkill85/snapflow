package projects_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/projects/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// Row-level security is the second wall: the store, called directly with
// another tenant's scope (no service check), sees and changes nothing of a
// foreign tenant.
func TestRowLevelSecurity(t *testing.T) {
	api := apptest.New(t)
	ctx := t.Context()
	newType(t, api, "zigbee", true)
	acme := api.NewTenant("Acme")
	other := api.NewTenant("Other")
	acmeUser := api.NewUser(acme, auth.RoleUser)
	otherUser := api.NewUser(other, auth.RoleUser)
	own := create(t, api, acmeUser.Cookie, map[string]any{"name": "Own"})
	foreign := create(t, api, otherUser.Cookie, map[string]any{"name": "Foreign"})

	acmeActor := auth.Actor{UserID: acmeUser.UserID, TenantID: acme, Role: auth.RoleUser}
	// scoped runs fn as acmeActor and rolls back.
	scoped := func(actor auth.Actor, fn func(q *store.Queries)) {
		t.Helper()
		tx, err := api.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := database.SetScope(ctx, tx, actor); err != nil {
			t.Fatal(err)
		}
		fn(store.New(tx))
	}

	scoped(acmeActor, func(q *store.Queries) {
		if _, err := q.GetProject(ctx, foreign.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("foreign read: %v", err)
		}
		if _, err := q.GetProject(ctx, own.ID); err != nil {
			t.Errorf("own read: %v", err)
		}
		rows, err := q.ListProjects(ctx, store.ListProjectsParams{RowLimit: 10})
		if err != nil || len(rows) != 1 || rows[0].ID != own.ID {
			t.Errorf("list without tenant filter: %v %v", rows, err)
		}
		versions, err := q.ListVersions(ctx, foreign.ID)
		if err != nil || len(versions) != 0 {
			t.Errorf("foreign versions: %v %v", versions, err)
		}
		if n, err := q.DeleteProject(ctx, foreign.ID); err != nil || n != 0 {
			t.Errorf("foreign delete: %d %v", n, err)
		}
		if _, err := q.UpdateProject(ctx, store.UpdateProjectParams{
			ID: foreign.ID, TenantID: other, Number: "x", Name: "Hacked", Status: "active",
			Language: "en", Currency: "USD", ExchangeRate: "1",
		}); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("foreign update: %v", err)
		}
	})
	// Writes into another tenant violate the policy's WITH CHECK.
	for name, write := range map[string]func(q *store.Queries) error{
		"insert project": func(q *store.Queries) error {
			_, err := q.CreateProject(ctx, store.CreateProjectParams{
				TenantID: other, Number: "x", Name: "Planted", Language: "en", Currency: "USD", ExchangeRate: "1",
			})
			return err
		},
		"move own project": func(q *store.Queries) error {
			_, err := q.UpdateProject(ctx, store.UpdateProjectParams{
				ID: own.ID, TenantID: other, Number: "x", Name: "Moved", Status: "active",
				Language: "en", Currency: "USD", ExchangeRate: "1",
			})
			return err
		},
		"insert version": func(q *store.Queries) error {
			_, err := q.CreateVersion(ctx, store.CreateVersionParams{TenantID: other, ProjectID: foreign.ID, Name: "X"})
			return err
		},
		"draw number": func(q *store.Queries) error {
			_, err := q.NextProjectNumber(ctx, store.NextProjectNumberParams{TenantID: other, Year: 2026})
			return err
		},
	} {
		scoped(acmeActor, func(q *store.Queries) {
			var pgErr *pgconn.PgError
			if err := write(q); !errors.As(err, &pgErr) || pgErr.Code != "42501" {
				t.Errorf("%s: want a row-level security violation, got %v", name, err)
			}
		})
	}

	// tenants.access_all sees every tenant.
	scoped(auth.Actor{TenantID: api.Distributor, Role: auth.RoleAdmin}, func(q *store.Queries) {
		rows, err := q.ListProjects(ctx, store.ListProjectsParams{RowLimit: 10})
		if err != nil || len(rows) != 2 {
			t.Errorf("admin: %v %v", rows, err)
		}
	})

	// The role alone, without a tenant, sees nothing; the scope ends with the
	// transaction.
	tx, err := api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+database.AppRole); err != nil {
		t.Fatal(err)
	}
	if rows, err := store.New(tx).ListProjects(ctx, store.ListProjectsParams{RowLimit: 10}); err != nil || len(rows) != 0 {
		t.Errorf("no scope: %v %v", rows, err)
	}
	_ = tx.Rollback(ctx)
	err = database.InScope(ctx, api.DB, acmeActor, pgx.TxOptions{}, func(pgx.Tx) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	var user, tenant string
	if err := api.DB.QueryRow(ctx, "SELECT current_user, coalesce(current_setting('app.tenant_id', true), '')").Scan(&user, &tenant); err != nil {
		t.Fatal(err)
	}
	if user == database.AppRole || tenant != "" {
		t.Errorf("scope leaked to the pool: %s %q", user, tenant)
	}

}
