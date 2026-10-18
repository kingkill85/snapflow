package plans_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// Row-level security on plans, plan_zones and plan_placements: the store,
// called directly with another tenant's scope (no service check), sees and
// changes nothing of a foreign tenant (D167).
func TestRowLevelSecurity(t *testing.T) {
	api := apptest.New(t)
	ctx := t.Context()
	c := newCatalog(t, api, "zigbee")
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleUser)
	own := createPlan(t, api, acmeUser.Cookie, newProject(t, api, acmeUser.Cookie, c.TypeID).Versions[0].ID, "Own", 100, 100)
	foreignVersion := newProject(t, api, otherUser.Cookie, c.TypeID).Versions[0].ID
	foreign := createPlan(t, api, otherUser.Cookie, foreignVersion, "Foreign", 100, 100)
	lock(t, api, otherUser.Cookie, foreign.ID)
	wantCode(t, save(api, otherUser.Cookie, getContent(t, api, otherUser.Cookie, foreign.ID),
		[]any{zone(uuid.New(), rect(0, 0, 10, 10)...)}, []any{placement(uuid.New(), c.Main, 5, 5)}), http.StatusOK, "")

	acmeActor := auth.Actor{UserID: acmeUser.UserID, TenantID: acme, Role: auth.RoleUser}
	scoped := func(fn func(q *store.Queries) error) error {
		t.Helper()
		tx, err := api.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := database.SetScope(ctx, tx, acmeActor); err != nil {
			t.Fatal(err)
		}
		return fn(store.New(tx))
	}

	_ = scoped(func(q *store.Queries) error {
		if _, err := q.GetPlan(ctx, foreign.ID); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("foreign plan read: %v", err)
		}
		if _, err := q.GetPlan(ctx, own.ID); err != nil {
			t.Errorf("own plan read: %v", err)
		}
		if rows, err := q.ListPlans(ctx, foreignVersion); err != nil || len(rows) != 0 {
			t.Errorf("foreign plans: %v %v", rows, err)
		}
		if rows, err := q.ListZones(ctx, foreign.ID); err != nil || len(rows) != 0 {
			t.Errorf("foreign zones: %v %v", rows, err)
		}
		if rows, err := q.ListPlacements(ctx, foreign.ID); err != nil || len(rows) != 0 {
			t.Errorf("foreign placements: %v %v", rows, err)
		}
		if n, err := q.DeletePlan(ctx, foreign.ID); err != nil || n != 0 {
			t.Errorf("foreign delete: %d %v", n, err)
		}
		if err := q.DeleteZones(ctx, foreign.ID); err != nil {
			t.Errorf("foreign zone delete: %v", err)
		}
		if err := q.DeletePlacements(ctx, foreign.ID); err != nil {
			t.Errorf("foreign placement delete: %v", err)
		}
		if err := q.SetLock(ctx, store.SetLockParams{ID: foreign.ID}); err != nil {
			t.Errorf("foreign lock: %v", err)
		}
		return nil
	})
	// Nothing of the foreign plan changed.
	var zones, placements int
	var locked bool
	if err := api.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM plan_zones WHERE plan_id = $1),
		(SELECT count(*) FROM plan_placements WHERE plan_id = $1),
		(SELECT lock_user_id IS NOT NULL FROM plans WHERE id = $1)`, foreign.ID).Scan(&zones, &placements, &locked); err != nil {
		t.Fatal(err)
	}
	if zones != 1 || placements != 1 || !locked {
		t.Errorf("foreign content changed: %d zones, %d placements, locked %v", zones, placements, locked)
	}

	// Writes into another tenant violate the policies' WITH CHECK.
	for name, write := range map[string]func(q *store.Queries) error{
		"plan": func(q *store.Queries) error {
			_, err := q.CreatePlan(ctx, store.CreatePlanParams{
				TenantID: other, VersionID: foreignVersion, Name: "Planted", ImageFileID: foreign.Image.FileID, ImageWidth: 1, ImageHeight: 1,
			})
			return err
		},
		"zone": func(q *store.Queries) error {
			return q.InsertZones(ctx, store.InsertZonesParams{TenantID: other, PlanID: foreign.ID,
				Rows: []byte(`[{"id":"` + uuid.NewString() + `","name":"X","color":"#000000","opacity":1,"points":[],"position":1}]`)})
		},
		"placement": func(q *store.Queries) error {
			return q.InsertPlacements(ctx, store.InsertPlacementsParams{TenantID: other, PlanID: foreign.ID,
				Rows: []byte(`[{"id":"` + uuid.NewString() + `","x":1,"y":1,"width":1,"height":1,"rotation":0,"label":"","existing":false,"addon_variant_ids":[],"instance_values":{},"position":1}]`)})
		},
	} {
		var pgErr *pgconn.PgError
		if err := scoped(write); !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Errorf("%s in another tenant: %v", name, err)
		}
	}
}
