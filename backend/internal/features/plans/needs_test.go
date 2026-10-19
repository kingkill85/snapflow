package plans_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// needCatalog creates function types: light (any load type), blind (only
// the load type motor), and the load types led and motor.
type needFixture struct {
	Light, Blind, LED, Motor string
}

func newNeedCatalog(t *testing.T, api *apptest.API) needFixture {
	t.Helper()
	admin := api.Admin.Cookie
	var f needFixture
	loadType := func(key string) string {
		resp := api.Post("/api/load-types", admin, map[string]any{"key": "n_" + key, "name": text(key), "isActive": true})
		wantCode(t, resp, http.StatusCreated, "")
		return decode[struct{ ID string }](t, resp).ID
	}
	f.LED, f.Motor = loadType("led"), loadType("motor")
	functionType := func(key string, loads []string) string {
		resp := api.Post("/api/function-types", admin, map[string]any{"key": key, "name": text(key), "loadTypeIds": loads})
		wantCode(t, resp, http.StatusCreated, "")
		return decode[struct{ ID string }](t, resp).ID
	}
	f.Light, f.Blind = functionType("n_light", nil), functionType("n_blind", []string{f.Motor})
	return f
}

func need(id uuid.UUID, functionType string, zoneID *uuid.UUID) map[string]any {
	return map[string]any{"id": id, "zoneId": zoneID, "functionTypeId": functionType, "quantity": 1, "powerW": nil,
		"loadTypeId": nil, "label": "", "note": "", "x": nil, "y": nil}
}

func symbol(id uuid.UUID, functionType string, x, y float64) map[string]any {
	n := need(id, functionType, nil)
	n["x"], n["y"] = x, y
	return n
}

func saveNeeds(api *apptest.API, cookie string, c plans.PlanContent, zones []any, needs []any) *httptest.ResponseRecorder {
	body := map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": c.Scale, "zones": zones, "placements": []any{},
	}
	if needs != nil {
		body["needs"] = needs
	}
	return api.Put("/api/plans/"+c.PlanID.String()+"/content", cookie, body)
}

func ptr[T any](v T) *T { return &v }

func deactivateLoadType(t *testing.T, api *apptest.API, id, key string) {
	t.Helper()
	resp := api.Get("/api/load-types/"+id, api.Admin.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	lt := decode[struct{ UpdatedAt string }](t, resp)
	wantCode(t, api.Put("/api/load-types/"+id, api.Admin.Cookie, map[string]any{
		"key": key, "name": text(key), "isActive": false, "expectedUpdatedAt": lt.UpdatedAt}), http.StatusOK, "")
}

func TestNeeds(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	f := newNeedCatalog(t, api)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	pl := createPlan(t, api, user.Cookie, newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID, "Ground", 1000, 1000)
	lock(t, api, user.Cookie, pl.ID)
	outer, inner := uuid.New(), uuid.New()
	zones := []any{zone(outer, rect(0, 0, 500, 500)...), zone(inner, rect(100, 100, 200, 200)...)}

	// Validation.
	bad := []any{
		need(uuid.Nil, uuid.NewString(), &outer),
		func() map[string]any {
			n := need(uuid.New(), f.Light, nil)
			n["quantity"] = 0
			n["powerW"] = "-1"
			return n
		}(),
		func() map[string]any { n := need(uuid.New(), f.Blind, &outer); n["loadTypeId"] = f.LED; return n }(),
		func() map[string]any {
			n := need(uuid.New(), f.Light, ptr(uuid.New()))
			n["label"] = string(make([]rune, 101))
			return n
		}(),
		func() map[string]any { n := symbol(uuid.New(), f.Light, 2000, 5); return n }(),
		func() map[string]any { n := symbol(uuid.New(), f.Light, 5, 5); n["y"] = nil; return n }(),
		func() map[string]any {
			n := need(uuid.New(), f.Light, &outer)
			n["loadTypeId"] = uuid.NewString()
			return n
		}(),
		func() map[string]any { n := need(uuid.New(), f.Light, &outer); n["powerW"] = "7.555"; return n }(),
		func() map[string]any { n := need(uuid.New(), f.Light, &outer); n["powerW"] = "100000.01"; return n }(),
	}
	got := fields(t, saveNeeds(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), zones, bad))
	want := []string{
		"body.needs[0].id plan.duplicate_id", "body.needs[0].functionTypeId function_type.not_found",
		"body.needs[1].quantity validation.range", "body.needs[1].powerW need.power_invalid", "body.needs[1].zoneId validation.required",
		"body.needs[2].loadTypeId need.load_type_not_allowed",
		"body.needs[3].label validation.too_long", "body.needs[3].zoneId need.zone_not_found",
		"body.needs[4].x plan.outside_image", "body.needs[5].x need.position_partial",
		"body.needs[6].loadTypeId load_type.not_found",
		"body.needs[7].powerW need.power_invalid", "body.needs[8].powerW need.power_invalid",
	}
	for _, w := range want {
		if !slices.Contains(got, w) {
			t.Errorf("missing %q in %v", w, got)
		}
	}
	// Limit.
	many := make([]any, plans.MaxNeeds+1)
	for i := range many {
		many[i] = need(uuid.New(), f.Light, &outer)
	}
	if got := fields(t, saveNeeds(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), zones, many)); !slices.Contains(got, "body.needs validation.too_many") {
		t.Errorf("limit: %v", got)
	}

	// A valid save: zone needs and symbols in the inner (nested) zone, the
	// outer zone and outside every zone.
	zn, sInner, sOuter, sNone := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	withLoad := need(zn, f.Blind, &inner)
	withLoad["loadTypeId"], withLoad["quantity"], withLoad["powerW"], withLoad["label"] = f.Motor, 3, "60.5", " Window "
	resp := saveNeeds(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), zones, []any{
		withLoad, symbol(sInner, f.Light, 150, 150), symbol(sOuter, f.Light, 300, 300), symbol(sNone, f.Light, 800, 800),
	})
	wantCode(t, resp, http.StatusOK, "")
	content := decode[plans.PlanContent](t, resp)
	if len(content.Needs) != 4 {
		t.Fatalf("needs: %+v", content.Needs)
	}
	n0, n1, n2, n3 := content.Needs[0], content.Needs[1], content.Needs[2], content.Needs[3]
	if n0.ZoneID == nil || *n0.ZoneID != inner || n0.Quantity != 3 || n0.PowerW == nil || *n0.PowerW != "60.50" || n0.Label != "Window" ||
		n0.LoadTypeID == nil || n0.LoadTypeID.String() != f.Motor {
		t.Errorf("zone need: %+v", n0)
	}
	if n1.ZoneID == nil || *n1.ZoneID != inner || n2.ZoneID == nil || *n2.ZoneID != outer || n3.ZoneID != nil {
		t.Errorf("symbol zones: %v %v %v", n1.ZoneID, n2.ZoneID, n3.ZoneID)
	}
	if len(content.NeedWarnings) != 1 || content.NeedWarnings[0].NeedID != sNone || content.NeedWarnings[0].Code != plans.WarnNeedOutsideZones {
		t.Errorf("warnings: %+v", content.NeedWarnings)
	}
	if got := getContent(t, api, user.Cookie, pl.ID); len(got.Needs) != 4 || got.Needs[0].ID != zn {
		t.Errorf("reload: %+v", got.Needs)
	}
	// The need count is units (D342): 3 + 1 + 1 + 1.
	if p := getPlan(t, api, user.Cookie, pl.ID); p.NeedCount != 6 {
		t.Errorf("need count %d", p.NeedCount)
	}

	// The function type is in use; deleting it is refused.
	wantCode(t, api.Delete("/api/function-types/"+f.Blind, api.Admin.Cookie), http.StatusConflict, "function_type.in_use")
	wantCode(t, api.Delete("/api/load-types/"+f.Motor, api.Admin.Cookie), http.StatusConflict, "load_type.in_use")

	// Catalog changes: the blind no longer allows motor, the light is
	// retired. Stored needs are kept with warnings; new ones are refused.
	wantCode(t, api.Put("/api/function-types/"+f.Blind, api.Admin.Cookie, map[string]any{
		"key": "n_blind", "name": text("n_blind"), "loadTypeIds": []string{f.LED}}), http.StatusOK, "")
	wantCode(t, api.Put("/api/function-types/"+f.Light, api.Admin.Cookie, map[string]any{
		"key": "n_light", "name": text("n_light"), "isActive": false}), http.StatusOK, "")
	content = getContent(t, api, user.Cookie, pl.ID)
	codes := map[string]int{}
	for _, w := range content.NeedWarnings {
		codes[string(w.Code)]++
	}
	if codes["need_load_type_not_allowed"] != 1 || codes["need_function_type_inactive"] != 3 || codes["need_outside_zones"] != 1 {
		t.Errorf("warnings after catalog change: %+v", content.NeedWarnings)
	}
	resp = saveNeeds(api, user.Cookie, content, zones, []any{
		withLoad, symbol(sInner, f.Light, 150, 150), symbol(uuid.New(), f.Light, 10, 10),
	})
	if got := fields(t, resp); len(got) != 1 || got[0] != "body.needs[2].functionTypeId need.function_type_inactive" {
		t.Errorf("inactive function type: %v", got)
	}
	// A need the editor restores by undo after an autosave dropped it is
	// not stored any more; marked restored it keeps its inactive function
	// type (D343). Saved without sOuter and sNone first.
	resp = saveNeeds(api, user.Cookie, content, zones, []any{withLoad, symbol(sInner, f.Light, 150, 150)})
	wantCode(t, resp, http.StatusOK, "")
	content = decode[plans.PlanContent](t, resp)
	restoredBody := map[string]any{
		"expectedContentUpdatedAt": content.ContentUpdatedAt, "scale": content.Scale, "zones": zones, "placements": []any{},
		"needs":           []any{withLoad, symbol(sInner, f.Light, 150, 150), symbol(sOuter, f.Light, 300, 300)},
		"restoredNeedIds": []uuid.UUID{sOuter},
	}
	resp = api.Put("/api/plans/"+pl.ID.String()+"/content", user.Cookie, restoredBody)
	wantCode(t, resp, http.StatusOK, "")
	content = decode[plans.PlanContent](t, resp)

	// A stored need whose load type became inactive keeps it.
	deactivateLoadType(t, api, f.Motor, "n_motor")
	resp = saveNeeds(api, user.Cookie, content, zones, []any{withLoad, symbol(sInner, f.Light, 150, 150), symbol(sOuter, f.Light, 300, 300)})
	wantCode(t, resp, http.StatusOK, "")
	content = decode[plans.PlanContent](t, resp)
	if n := content.Needs[0]; n.LoadTypeID == nil || n.LoadTypeID.String() != f.Motor {
		t.Errorf("inactive load type not kept: %+v", n)
	}
	// ... but a new need cannot take it.
	fresh := need(uuid.New(), f.Blind, &inner)
	fresh["loadTypeId"] = f.Motor
	if got := fields(t, saveNeeds(api, user.Cookie, content, zones, []any{withLoad, fresh})); !slices.Contains(got, "body.needs[1].loadTypeId need.load_type_inactive") {
		t.Errorf("new need with inactive load type: %v", got)
	}

	// "needs": null is the same as leaving needs out: the stored ones stay.
	nullBody := map[string]any{"expectedContentUpdatedAt": content.ContentUpdatedAt, "scale": content.Scale, "zones": zones,
		"placements": []any{}, "needs": nil}
	resp = api.Put("/api/plans/"+pl.ID.String()+"/content", user.Cookie, nullBody)
	wantCode(t, resp, http.StatusOK, "")
	content = decode[plans.PlanContent](t, resp)
	if len(content.Needs) != 3 {
		t.Errorf("needs null: %+v", content.Needs)
	}

	// Needs left out are kept, except those of deleted zones; moving the
	// zone moves the symbol's zone.
	resp = saveNeeds(api, user.Cookie, content, []any{zone(outer, rect(0, 0, 900, 900)...)}, nil)
	wantCode(t, resp, http.StatusOK, "")
	content = decode[plans.PlanContent](t, resp)
	if len(content.Needs) != 2 || content.Needs[0].ID != sInner || *content.Needs[0].ZoneID != outer || content.Needs[1].ZoneID == nil {
		t.Errorf("kept needs: %+v", content.Needs)
	}

	// Stale and lock rules hold for needs too.
	wantCode(t, saveNeeds(api, user.Cookie, plans.PlanContent{PlanID: pl.ID}, []any{}, []any{}), http.StatusConflict, "plan.stale")
	wantCode(t, api.Delete("/api/plans/"+pl.ID.String()+"/lock", user.Cookie), http.StatusNoContent, "")
	wantCode(t, saveNeeds(api, user.Cookie, content, []any{}, []any{}), http.StatusConflict, "plan.lock_required")
}

func TestNeedsSummaryAndCopy(t *testing.T) {
	var copiedPlans map[uuid.UUID]uuid.UUID
	api := apptest.NewWithPlanCopier(t, func(_ context.Context, _ pgx.Tx, planIDs map[uuid.UUID]uuid.UUID, _, _ projects.VersionRef) error {
		copiedPlans = planIDs
		return nil
	})
	c := newCatalog(t, api, "zigbee")
	f := newNeedCatalog(t, api)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.TypeID)
	source := p.Versions[0].ID
	pl := createPlan(t, api, user.Cookie, source, "Ground", 1000, 1000)
	lock(t, api, user.Cookie, pl.ID)
	z := uuid.New()
	n1 := need(uuid.New(), f.Blind, &z)
	n1["quantity"], n1["powerW"], n1["loadTypeId"] = 3, "33.33", f.Motor
	n2 := need(uuid.New(), f.Light, &z)
	n2["quantity"] = 4
	n3 := symbol(uuid.New(), f.Light, 900, 900)
	n3["powerW"], n3["loadTypeId"] = "0.1", f.LED
	zz := zone(z, rect(0, 0, 100, 100)...)
	zz["name"] = "Kitchen"
	wantCode(t, saveNeeds(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), []any{zz}, []any{n1, n2, n3}), http.StatusOK, "")

	resp := api.Get("/api/versions/"+source.String()+"/needs", user.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	sum := decode[plans.VersionNeeds](t, resp)
	if len(sum.Plans) != 1 || len(sum.Plans[0].Zones) != 2 {
		t.Fatalf("summary: %+v", sum)
	}
	kitchen, none := sum.Plans[0].Zones[0], sum.Plans[0].Zones[1]
	if kitchen.Name != "Kitchen" || kitchen.ZoneID == nil || len(kitchen.Needs) != 2 || kitchen.Totals.Quantity != 7 || kitchen.Totals.PowerW != "99.99" ||
		none.ZoneID != nil || len(none.Needs) != 1 || !none.Needs[0].Symbol {
		t.Errorf("zones: %+v", sum.Plans[0].Zones)
	}
	if kitchen.Needs[0].FunctionType.Key != "n_blind" || kitchen.Needs[0].LoadType == nil || kitchen.Needs[0].LoadType.Key != "n_motor" {
		t.Errorf("need refs: %+v", kitchen.Needs[0])
	}
	// Exact decimal sums (D341): 3 × 33.33 + 0.10.
	if none.Needs[0].PowerW == nil || *none.Needs[0].PowerW != "0.10" || none.Totals.PowerW != "0.10" {
		t.Errorf("no zone: %+v", none)
	}
	if sum.Totals.Quantity != 8 || sum.Totals.PowerW != "100.09" || sum.LoadTypes[2].Totals.PowerW != "0.00" || len(sum.FunctionTypes) != 2 ||
		sum.FunctionTypes[0].FunctionType.Key != "n_blind" || sum.FunctionTypes[1].Totals.Quantity != 5 {
		t.Errorf("totals: %+v %+v", sum.Totals, sum.FunctionTypes)
	}
	if len(sum.LoadTypes) != 3 || sum.LoadTypes[2].LoadType != nil || sum.LoadTypes[2].Totals.Quantity != 4 {
		t.Errorf("load type totals: %+v", sum.LoadTypes)
	}
	// Another tenant does not see the version.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	wantCode(t, api.Get("/api/versions/"+source.String()+"/needs", other.Cookie), http.StatusNotFound, "")

	// Version copy copies the needs with their ids and zones (D339) and
	// hands the plan id map to the plan copiers.
	resp = api.Post("/api/projects/"+p.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V2", "sourceVersionId": source})
	wantCode(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	copied := decode[[]plans.Plan](t, api.Get("/api/versions/"+target.String()+"/plans", user.Cookie))
	content := getContent(t, api, user.Cookie, copied[0].ID)
	if len(content.Needs) != 3 || content.Needs[0].ID != n1["id"] || content.Needs[0].ZoneID == nil || *content.Needs[0].ZoneID != z ||
		content.Zones[0].ID != z || content.Needs[2].X == nil || *content.Needs[2].X != 900 {
		t.Errorf("copied needs: %+v", content.Needs)
	}
	if len(copiedPlans) != 1 || copiedPlans[pl.ID] != copied[0].ID || copied[0].ID == pl.ID {
		t.Errorf("plan id map: %v", copiedPlans)
	}
}

// Row-level security on plan_needs (D167).
func TestNeedsRowLevelSecurity(t *testing.T) {
	api := apptest.New(t)
	ctx := t.Context()
	c := newCatalog(t, api, "zigbee")
	f := newNeedCatalog(t, api)
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleUser)
	foreign := createPlan(t, api, otherUser.Cookie, newProject(t, api, otherUser.Cookie, c.TypeID).Versions[0].ID, "Foreign", 100, 100)
	lock(t, api, otherUser.Cookie, foreign.ID)
	wantCode(t, saveNeeds(api, otherUser.Cookie, getContent(t, api, otherUser.Cookie, foreign.ID), []any{},
		[]any{symbol(uuid.New(), f.Light, 5, 5)}), http.StatusOK, "")

	scoped := func(fn func(q *store.Queries) error) error {
		t.Helper()
		tx, err := api.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := database.SetScope(ctx, tx, auth.Actor{UserID: acmeUser.UserID, TenantID: acme, Role: auth.RoleUser}); err != nil {
			t.Fatal(err)
		}
		return fn(store.New(tx))
	}
	_ = scoped(func(q *store.Queries) error {
		if rows, err := q.ListNeeds(ctx, foreign.ID); err != nil || len(rows) != 0 {
			t.Errorf("foreign needs: %v %v", rows, err)
		}
		if err := q.DeleteNeeds(ctx, foreign.ID); err != nil {
			t.Errorf("foreign need delete: %v", err)
		}
		return nil
	})
	var n int
	if err := api.DB.QueryRow(ctx, `SELECT count(*) FROM plan_needs WHERE plan_id = $1`, foreign.ID).Scan(&n); err != nil || n != 1 {
		t.Errorf("foreign needs changed: %d %v", n, err)
	}
	err := scoped(func(q *store.Queries) error {
		return q.InsertNeeds(ctx, store.InsertNeedsParams{TenantID: other, PlanID: foreign.ID,
			Rows: []byte(`[{"id":"` + uuid.NewString() + `","function_type_id":"` + f.Light + `","quantity":1,"label":"","note":"","x":1,"y":1,"position":1}]`)})
	})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Errorf("need in another tenant: %v", err)
	}
}

// Replacing the image scales load symbols with the content (D194), keeps
// them inside the image and recomputes their zones (D325).
func TestNeedsImageReplace(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	f := newNeedCatalog(t, api)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	pl := createPlan(t, api, user.Cookie, newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID, "Ground", 1000, 500)
	lock(t, api, user.Cookie, pl.ID)
	z, inside, edge, zoneNeed := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	zones := []any{zone(z, rect(100, 100, 500, 400)...)}
	resp := saveNeeds(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), zones,
		[]any{symbol(inside, f.Light, 450, 300), symbol(edge, f.Light, 1000, 500), need(zoneNeed, f.Light, &z)})
	wantCode(t, resp, http.StatusOK, "")

	resp = multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
		map[string]string{"name": "Ground", "expectedUpdatedAt": pl.UpdatedAt.Format(time.RFC3339Nano)}, pngImage(t, 2000, 1000))
	wantCode(t, resp, http.StatusOK, "")
	after := getContent(t, api, user.Cookie, pl.ID)
	if len(after.Needs) != 3 {
		t.Fatalf("needs: %+v", after.Needs)
	}
	in, e, zn := after.Needs[0], after.Needs[1], after.Needs[2]
	if *in.X != 900 || *in.Y != 600 || in.ZoneID == nil || *in.ZoneID != z {
		t.Errorf("symbol inside: %v %v %v", *in.X, *in.Y, in.ZoneID)
	}
	if *e.X != 2000 || *e.Y != 1000 || e.ZoneID != nil {
		t.Errorf("symbol at the edge: %v %v %v", *e.X, *e.Y, e.ZoneID)
	}
	if zn.X != nil || zn.ZoneID == nil || *zn.ZoneID != z {
		t.Errorf("zone need: %+v", zn)
	}

	// A smaller image of another aspect ratio: the symbol moves out of the
	// (scaled) zone's corner only if the zone does; it stays in its zone.
	replaced := getPlan(t, api, user.Cookie, pl.ID)
	resp = multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
		map[string]string{"name": "Ground", "expectedUpdatedAt": replaced.UpdatedAt.Format(time.RFC3339Nano)}, pngImage(t, 100, 100))
	wantCode(t, resp, http.StatusOK, "")
	after = getContent(t, api, user.Cookie, pl.ID)
	in, e = after.Needs[0], after.Needs[1]
	if *in.X != 45 || *in.Y != 60 || in.ZoneID == nil || *in.ZoneID != z || *e.X != 100 || *e.Y != 100 {
		t.Errorf("after the aspect change: %v,%v %v / %v,%v", *in.X, *in.Y, in.ZoneID, *e.X, *e.Y)
	}
}

// A read-only project refuses content saves with needs.
func TestNeedsReadOnlyProject(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	f := newNeedCatalog(t, api)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.TypeID)
	pl := createPlan(t, api, user.Cookie, p.Versions[0].ID, "Ground", 100, 100)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), user.Cookie, map[string]any{
		"name": "House", "status": "completed", "expectedUpdatedAt": p.UpdatedAt,
	}), http.StatusOK, "")
	wantCode(t, saveNeeds(api, user.Cookie, content, []any{}, []any{symbol(uuid.New(), f.Light, 5, 5)}), http.StatusConflict, "project.read_only")
	if got := getContent(t, api, user.Cookie, pl.ID); len(got.Needs) != 0 {
		t.Errorf("needs saved on a read-only project: %+v", got.Needs)
	}
}
