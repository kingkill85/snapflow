package plans_test

import (
	"net/http"
	"net/http/httptest"
	"path"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

func TestPlanCRUD(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.TypeID)
	version := p.Versions[0].ID

	ground := createPlan(t, api, user.Cookie, version, " Ground floor ", 800, 600)
	if ground.Name != "Ground floor" || ground.Position != 1 || ground.Kind != plans.KindFloorplan ||
		ground.Image.Width != 800 || ground.Image.Height != 600 || ground.ProjectID != p.ID || ground.Lock != nil ||
		!ground.Can.Update || ground.Can.BreakLock {
		t.Fatalf("created: %+v", ground)
	}
	first := createPlan(t, api, user.Cookie, version, "First floor", 400, 300)
	if first.Position != 2 {
		t.Errorf("second plan position %d", first.Position)
	}
	wantCode(t, createPlanResp(t, api, user.Cookie, version, "GROUND FLOOR", pngImage(t, 10, 10)), http.StatusConflict, "plan.name_taken")
	if got := fields(t, createPlanResp(t, api, user.Cookie, version, "  ", pngImage(t, 10, 10))); !slices.Equal(got, []string{"body.name validation.required"}) {
		t.Errorf("empty name: %v", got)
	}

	// The image is served for the plan.
	resp := api.Get(ground.Image.URL, user.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	if resp.Header().Get("Content-Type") != "image/png" {
		t.Errorf("image type %q", resp.Header().Get("Content-Type"))
	}

	// Rename (stale check), reorder, delete.
	upd := func(pl plans.Plan, name string, expected time.Time) *httptest.ResponseRecorder {
		return multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
			map[string]string{"name": name, "expectedUpdatedAt": expected.Format(time.RFC3339Nano)}, nil)
	}
	resp = upd(ground, "Ground", ground.UpdatedAt)
	wantCode(t, resp, http.StatusOK, "")
	renamed := decode[plans.Plan](t, resp)
	if renamed.Name != "Ground" || renamed.ContentUpdatedAt != ground.ContentUpdatedAt {
		t.Errorf("renamed: %+v", renamed)
	}
	wantCode(t, upd(ground, "Again", ground.UpdatedAt), http.StatusConflict, "plan.stale")
	wantCode(t, upd(first, "ground", first.UpdatedAt), http.StatusConflict, "plan.name_taken")

	order := "/api/versions/" + version.String() + "/plans/order"
	resp = api.Put(order, user.Cookie, map[string]any{"ids": []uuid.UUID{first.ID, ground.ID}})
	wantCode(t, resp, http.StatusOK, "")
	list := decode[[]plans.Plan](t, resp)
	if len(list) != 2 || list[0].ID != first.ID || list[0].Position != 1 {
		t.Errorf("reordered: %+v", list)
	}
	wantCode(t, api.Put(order, user.Cookie, map[string]any{"ids": []uuid.UUID{first.ID}}), http.StatusUnprocessableEntity, "plan.order_mismatch")
	wantCode(t, api.Put(order, user.Cookie, map[string]any{"ids": []uuid.UUID{first.ID, first.ID}}), http.StatusUnprocessableEntity, "plan.order_mismatch")

	// Other tenants see nothing.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleTenantAdmin)
	wantCode(t, api.Get("/api/plans/"+ground.ID.String(), other.Cookie), http.StatusNotFound, "plan.not_found")
	wantCode(t, api.Get(ground.Image.URL, other.Cookie), http.StatusNotFound, "plan.not_found")
	wantCode(t, api.Get("/api/versions/"+version.String()+"/plans", other.Cookie), http.StatusNotFound, "project_version.not_found")
	wantCode(t, api.Delete("/api/plans/"+ground.ID.String(), other.Cookie), http.StatusNotFound, "plan.not_found")
	// The admin sees every tenant.
	getPlan(t, api, api.Admin.Cookie, ground.ID)

	wantCode(t, api.Delete("/api/plans/"+ground.ID.String(), user.Cookie), http.StatusNoContent, "")
	wantCode(t, api.Get("/api/plans/"+ground.ID.String(), user.Cookie), http.StatusNotFound, "plan.not_found")
	list = decode[[]plans.Plan](t, api.Get("/api/versions/"+version.String()+"/plans", user.Cookie))
	if len(list) != 1 {
		t.Errorf("after delete: %+v", list)
	}
}

func TestImageLimits(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	c := newCatalog(t, api, "zigbee")
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID

	// Stored at most 4096 px on the long side.
	wide := createPlan(t, api, user.Cookie, version, "Wide", 5000, 100)
	if wide.Image.Width != 4096 || wide.Image.Height != 82 {
		t.Errorf("wide stored as %dx%d", wide.Image.Width, wide.Image.Height)
	}
	// WebP is stored as PNG.
	resp := createPlanResp(t, api, user.Cookie, version, "WebP", webpImage(t))
	wantCode(t, resp, http.StatusCreated, "")
	if img := api.Get(decode[plans.Plan](t, resp).Image.URL, user.Cookie); img.Header().Get("Content-Type") != "image/png" {
		t.Errorf("webp stored as %q", img.Header().Get("Content-Type"))
	}
	// 40 megapixels at most (the catalog allows 25).
	wantCode(t, createPlanResp(t, api, user.Cookie, version, "Huge", pngHeader(t, 7000, 6000)), http.StatusUnprocessableEntity, "file.too_many_pixels")
	resp = createPlanResp(t, api, user.Cookie, version, "Big", append(pngImage(t, 2, 2), make([]byte, 20<<20)...))
	wantCode(t, resp, http.StatusRequestEntityTooLarge, "file.too_large")
	if p := decode[problem](t, resp); p.Params["maxMb"] != float64(20) {
		t.Errorf("too large params: %v", p.Params)
	}
	wantCode(t, createPlanResp(t, api, user.Cookie, version, "Text", []byte("not an image")), http.StatusUnsupportedMediaType, "file.type")
	// Readers may not upload.
	viewer := api.NewUser(api.NewTenant("Viewer"), auth.RoleUser)
	wantCode(t, createPlanResp(t, api, viewer.Cookie, version, "X", pngImage(t, 2, 2)), http.StatusNotFound, "project_version.not_found")
}

func TestContentValidation(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 1000, 500)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)
	if len(content.Zones) != 0 || len(content.Placements) != 0 || len(content.Warnings) != 0 {
		t.Fatalf("new content: %+v", content)
	}

	z1, p1 := uuid.New(), uuid.New()
	ok := placement(p1, c.Main, 999, 1)
	ok["rotation"] = -90
	ok["label"] = "  Hall light "
	ok["addonVariantIds"] = []string{c.Opt, c.Req, c.Opt}
	ok["instanceValues"] = map[string]any{"address": 7}
	ok["existing"] = true
	resp := save(api, user.Cookie, content, []any{zone(z1, rect(0, 0, 1000, 500)...)}, []any{ok})
	wantCode(t, resp, http.StatusOK, "")
	saved := decode[plans.PlanContent](t, resp)
	got := saved.Placements[0]
	if got.Rotation != 270 || got.Label != "Hall light" || !slices.Equal(got.AddonVariantIDs, []uuid.UUID{uuid.MustParse(c.Opt)}) ||
		got.InstanceValues["address"] != float64(7) || !got.Existing || got.ZoneID == nil || *got.ZoneID != z1 ||
		saved.Zones[0].Color != "#aabbcc" || !saved.ContentUpdatedAt.After(content.ContentUpdatedAt) {
		t.Errorf("saved: %+v %+v", got, saved)
	}
	if again := getContent(t, api, user.Cookie, pl.ID); again.Placements[0].Rotation != 270 || again.ContentUpdatedAt != saved.ContentUpdatedAt {
		t.Errorf("read back: %+v", again)
	}
	full := getPlan(t, api, user.Cookie, pl.ID)
	if full.ZoneCount != 1 || full.PlacementCount != 1 {
		t.Errorf("counts: %+v", full)
	}

	bad := func(mod func(p map[string]any)) map[string]any {
		p := placement(uuid.New(), c.Main, 10, 10)
		mod(p)
		return p
	}
	dup := uuid.New()
	got2 := fields(t, save(api, user.Cookie, saved,
		[]any{
			zone(dup, rect(0, 0, 10, 10)...),
			zone(dup, [2]float64{0, 0}, [2]float64{10, 10}),
			zone(uuid.New(), [2]float64{0, 0}, [2]float64{5, 5}, [2]float64{10, 10}),
			zone(uuid.New(), rect(0, 0, 1001, 10)...),
			map[string]any{"id": uuid.New(), "name": "", "color": "red", "opacity": 2, "points": rect(0, 0, 5, 5)},
		},
		[]any{
			bad(func(p map[string]any) { p["x"] = 1001 }),
			bad(func(p map[string]any) { p["width"] = 0; p["height"] = 501 }),
			bad(func(p map[string]any) { p["variantId"] = uuid.New() }),
			bad(func(p map[string]any) { p["variantId"] = nil }),
			bad(func(p map[string]any) { p["addonVariantIds"] = []string{c.Other} }),
			bad(func(p map[string]any) { p["instanceValues"] = map[string]any{"address": 300, "mac": "x"} }),
			bad(func(p map[string]any) { p["label"] = strings.Repeat("x", 101) }),
			bad(func(p map[string]any) { p["id"] = p1 }),
			bad(func(p map[string]any) { p["id"] = p1 }),
		}))
	want := []string{
		"body.zones[1].id plan.duplicate_id",
		"body.zones[1].points plan.zone_points",
		"body.zones[2].points plan.zone_degenerate",
		"body.zones[3].points[1] plan.outside_image",
		"body.zones[4].name validation.required",
		"body.zones[4].color plan.zone_color",
		"body.zones[4].opacity plan.zone_opacity",
		"body.placements[0].x plan.outside_image",
		"body.placements[1].width plan.placement_size",
		"body.placements[1].height plan.placement_size",
		"body.placements[2].variantId plan.variant_not_found",
		"body.placements[3].variantId plan.variant_required",
		"body.placements[4].addonVariantIds[0] plan.addon_not_linked",
		"body.placements[5].instanceValues.address attribute.range",
		"body.placements[5].instanceValues.mac attribute.unknown",
		"body.placements[6].label validation.too_long",
		"body.placements[8].id plan.duplicate_id",
	}
	for _, w := range want {
		if !slices.Contains(got2, w) {
			t.Errorf("missing %q in %v", w, got2)
		}
	}

	// Limits.
	many := make([]any, plans.MaxPlacements+1)
	for i := range many {
		many[i] = placement(uuid.New(), c.Main, 10, 10)
	}
	if got := fields(t, save(api, user.Cookie, saved, nil, many)); !slices.Equal(got, []string{"body.placements validation.too_many"}) {
		t.Errorf("too many placements: %v", got)
	}
	zones := make([]any, plans.MaxZones+1)
	for i := range zones {
		zones[i] = zone(uuid.New(), rect(0, 0, 10, 10)...)
	}
	if got := fields(t, save(api, user.Cookie, saved, zones, nil)); !slices.Equal(got, []string{"body.zones validation.too_many"}) {
		t.Errorf("too many zones: %v", got)
	}
	// The limits themselves are fine.
	resp = save(api, user.Cookie, saved, zones[:plans.MaxZones], many[:plans.MaxPlacements])
	wantCode(t, resp, http.StatusOK, "")
	if n := len(decode[plans.PlanContent](t, resp).Placements); n != plans.MaxPlacements {
		t.Errorf("saved %d placements", n)
	}
}

func TestZoneMembership(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 1000, 1000)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)

	house, room, closet, triangle := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	inCloset, inRoom, inHouse, outside, onEdge, onVertex, inTriangle := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	resp := save(api, user.Cookie, content,
		[]any{
			// The smallest zone wins, whatever the draw order.
			zone(closet, rect(100, 100, 200, 200)...),
			zone(house, rect(0, 0, 800, 800)...),
			zone(room, rect(50, 50, 400, 400)...),
			zone(triangle, [2]float64{600, 900}, [2]float64{900, 900}, [2]float64{750, 999}),
		},
		[]any{
			placement(inCloset, c.Main, 150, 150),
			placement(inRoom, c.Main, 300, 300),
			placement(inHouse, c.Main, 600, 600),
			placement(outside, c.Main, 950, 100),
			placement(onEdge, c.Main, 400, 250), // on the room's right edge
			placement(onVertex, c.Main, 200, 200),
			placement(inTriangle, c.Main, 750, 950),
		})
	wantCode(t, resp, http.StatusOK, "")
	zoneOf := map[uuid.UUID]*uuid.UUID{}
	for _, p := range decode[plans.PlanContent](t, resp).Placements {
		zoneOf[p.ID] = p.ZoneID
	}
	for id, want := range map[uuid.UUID]*uuid.UUID{
		inCloset: &closet, inRoom: &room, inHouse: &house, outside: nil, onEdge: &room, onVertex: &closet, inTriangle: &triangle,
	} {
		got := zoneOf[id]
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("placement %s: zone %v, want %v", id, got, want)
		}
	}

	// Moving a zone re-assigns on the next save.
	saved := decode[plans.PlanContent](t, resp)
	resp = save(api, user.Cookie, saved, []any{zone(room, rect(500, 500, 700, 700)...)}, []any{placement(inHouse, c.Main, 600, 600)})
	wantCode(t, resp, http.StatusOK, "")
	if z := decode[plans.PlanContent](t, resp).Placements[0].ZoneID; z == nil || *z != room {
		t.Errorf("after the move: %v", z)
	}
}

func TestWarnings(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	other := newCatalog(t, api, "knx")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 1000, 1000)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)

	main, foreign := uuid.New(), uuid.New()
	m := placement(main, c.Main, 10, 10)
	m["addonVariantIds"] = []string{c.Opt}
	resp := save(api, user.Cookie, content, nil, []any{m, placement(foreign, other.Main, 20, 20)})
	wantCode(t, resp, http.StatusOK, "")
	saved := decode[plans.PlanContent](t, resp)
	if w := saved.Warnings; len(w) != 1 || w[0].PlacementID != foreign || w[0].Code != plans.WarnProductTypeNotInProject {
		t.Fatalf("warnings: %+v", w)
	}

	// Deactivate the required and the optional add-on, then the variant.
	for _, id := range []string{c.Req, c.Opt, c.Main} {
		cur := decode[struct {
			Variants []struct {
				ID        string         `json:"id"`
				Name      map[string]any `json:"name"`
				Price     string         `json:"price"`
				UpdatedAt string         `json:"updatedAt"`
			} `json:"variants"`
		}](t, api.Get("/api/products/"+c.ProductID, api.Admin.Cookie))
		for _, vv := range cur.Variants {
			if vv.ID == id {
				wantCode(t, api.Put("/api/products/"+c.ProductID+"/variants/"+id, api.Admin.Cookie, map[string]any{
					"name": vv.Name, "price": vv.Price, "isActive": false, "expectedUpdatedAt": vv.UpdatedAt,
				}), http.StatusOK, "")
			}
		}
	}
	got := getContent(t, api, user.Cookie, pl.ID).Warnings
	codes := map[plans.PlanWarningCode]bool{}
	for _, w := range got {
		if w.PlacementID == main {
			codes[w.Code] = true
		}
	}
	for _, want := range []plans.PlanWarningCode{plans.WarnVariantInactive, plans.WarnRequiredAddonUnavailable, plans.WarnAddonUnavailable} {
		if !codes[want] {
			t.Errorf("missing warning %s in %+v", want, got)
		}
	}

	// A deleted variant keeps the placement (variant null, warning) and the
	// editor may send it back as it was loaded.
	wantCode(t, api.Delete("/api/products/"+other.ProductID+"/variants/"+other.Main, api.Admin.Cookie), http.StatusNoContent, "")
	loaded := getContent(t, api, user.Cookie, pl.ID)
	var stale map[string]any
	for _, p := range loaded.Placements {
		if p.ID == foreign {
			if p.VariantID != nil {
				t.Errorf("deleted variant still set: %v", p.VariantID)
			}
		}
	}
	stale = placement(foreign, other.Main, 20, 20) // as the editor had it before the delete
	resp = save(api, user.Cookie, loaded, nil, []any{m, stale})
	wantCode(t, resp, http.StatusOK, "")
	found := false
	for _, w := range decode[plans.PlanContent](t, resp).Warnings {
		found = found || (w.PlacementID == foreign && w.Code == plans.WarnVariantDeleted)
	}
	if !found {
		t.Errorf("no variant_deleted warning")
	}
}

func TestLockLifecycle(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	acme := api.NewTenant("Acme")
	alice := api.NewUser(acme, auth.RoleUser)
	bob := api.NewUser(acme, auth.RoleUser)
	boss := api.NewUser(acme, auth.RoleTenantAdmin)
	version := newProject(t, api, alice.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, alice.Cookie, version, "Ground", 100, 100)
	path := "/api/plans/" + pl.ID.String() + "/lock"
	content := getContent(t, api, alice.Cookie, pl.ID)

	// Saving needs the lock.
	wantCode(t, save(api, alice.Cookie, content, nil, nil), http.StatusConflict, "plan.lock_required")

	l := lock(t, api, alice.Cookie, pl.ID)
	if l.UserID != alice.UserID || !l.Mine || time.Until(l.ExpiresAt) < time.Minute {
		t.Errorf("lock: %+v", l)
	}
	if g := getPlan(t, api, bob.Cookie, pl.ID); g.Lock == nil || g.Lock.UserID != alice.UserID || g.Lock.Mine || g.Lock.Name == "" {
		t.Errorf("lock seen by bob: %+v", g.Lock)
	}
	renewed := lock(t, api, alice.Cookie, pl.ID)
	if !renewed.ExpiresAt.After(l.ExpiresAt) && !renewed.ExpiresAt.Equal(l.ExpiresAt) {
		t.Errorf("renewal moved the expiry back")
	}

	// Bob is refused, also for saves and image replacement.
	resp := api.Post(path, bob.Cookie, map[string]any{})
	wantCode(t, resp, http.StatusConflict, "plan.locked")
	if p := decode[problem](t, resp); p.Params["name"] == "" || p.Params["expiresAt"] == nil {
		t.Errorf("locked params: %v", p.Params)
	}
	wantCode(t, save(api, bob.Cookie, content, nil, nil), http.StatusConflict, "plan.lock_required")
	wantCode(t, multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), bob.Cookie,
		map[string]string{"name": "X", "expectedUpdatedAt": pl.UpdatedAt.Format(time.RFC3339Nano)}, pngImage(t, 50, 50)),
		http.StatusConflict, "plan.locked")
	wantCode(t, api.Delete("/api/plans/"+pl.ID.String(), bob.Cookie), http.StatusConflict, "plan.locked")
	// Only users with projects.delete may break it.
	wantCode(t, api.Post(path+"?force=true", bob.Cookie, map[string]any{}), http.StatusForbidden, "auth.forbidden")
	if !getPlan(t, api, boss.Cookie, pl.ID).Can.BreakLock || getPlan(t, api, bob.Cookie, pl.ID).Can.BreakLock {
		t.Errorf("breakLock flags")
	}
	resp = api.Post(path+"?force=true", boss.Cookie, map[string]any{})
	wantCode(t, resp, http.StatusOK, "")
	// Alice lost it.
	wantCode(t, save(api, alice.Cookie, content, nil, nil), http.StatusConflict, "plan.lock_required")
	// Release by someone else changes nothing; by the holder it frees the plan.
	wantCode(t, api.Delete(path, alice.Cookie), http.StatusNoContent, "")
	if getPlan(t, api, alice.Cookie, pl.ID).Lock == nil {
		t.Errorf("alice released boss's lock")
	}
	wantCode(t, api.Delete(path, boss.Cookie), http.StatusNoContent, "")
	if getPlan(t, api, alice.Cookie, pl.ID).Lock != nil {
		t.Errorf("lock not released")
	}

	// An expired lock is free for everybody.
	lock(t, api, bob.Cookie, pl.ID)
	if _, err := api.DB.Exec(t.Context(), `UPDATE plans SET lock_expires_at = now() - interval '1 second' WHERE id = $1`, pl.ID); err != nil {
		t.Fatal(err)
	}
	if getPlan(t, api, alice.Cookie, pl.ID).Lock != nil {
		t.Errorf("expired lock still shown")
	}
	wantCode(t, save(api, bob.Cookie, content, nil, nil), http.StatusConflict, "plan.lock_required")
	lock(t, api, alice.Cookie, pl.ID)
	wantCode(t, save(api, alice.Cookie, content, nil, nil), http.StatusOK, "")
}

// Two saves of the same content version: one wins, the other is stale.
func TestConcurrentSaves(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 100, 100)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)

	const n = 4
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = save(api, user.Cookie, content, nil, []any{placement(uuid.New(), c.Main, 50, 50)}).Code
		}()
	}
	wg.Wait()
	slices.Sort(codes)
	if codes[0] != http.StatusOK || codes[1] != http.StatusConflict || codes[n-1] != http.StatusConflict {
		t.Errorf("codes %v", codes)
	}
	if got := getContent(t, api, user.Cookie, pl.ID); len(got.Placements) != 1 {
		t.Errorf("stored %d placements", len(got.Placements))
	}
	wantCode(t, save(api, user.Cookie, content, nil, nil), http.StatusConflict, "plan.stale")
}

func TestReadOnlyProject(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.TypeID)
	version := p.Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 100, 100)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)

	wantCode(t, api.Put("/api/projects/"+p.ID.String(), user.Cookie, map[string]any{
		"name": "House", "status": "completed", "expectedUpdatedAt": p.UpdatedAt,
	}), http.StatusOK, "")

	got := getPlan(t, api, user.Cookie, pl.ID)
	if got.Can.Update || got.Can.BreakLock {
		t.Errorf("can on a read-only project: %+v", got.Can)
	}
	wantCode(t, save(api, user.Cookie, content, nil, nil), http.StatusConflict, "project.read_only")
	wantCode(t, api.Post("/api/plans/"+pl.ID.String()+"/lock", user.Cookie, map[string]any{}), http.StatusConflict, "project.read_only")
	wantCode(t, createPlanResp(t, api, user.Cookie, version, "New", pngImage(t, 10, 10)), http.StatusConflict, "project.read_only")
	wantCode(t, multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
		map[string]string{"name": "X", "expectedUpdatedAt": got.UpdatedAt.Format(time.RFC3339Nano)}, nil), http.StatusConflict, "project.read_only")
	wantCode(t, api.Delete("/api/plans/"+pl.ID.String(), user.Cookie), http.StatusConflict, "project.read_only")
	wantCode(t, api.Put("/api/versions/"+version.String()+"/plans/order", user.Cookie, map[string]any{"ids": []uuid.UUID{pl.ID}}), http.StatusConflict, "project.read_only")
	// The lock can still be released; reading works.
	wantCode(t, api.Delete("/api/plans/"+pl.ID.String()+"/lock", user.Cookie), http.StatusNoContent, "")
	getContent(t, api, user.Cookie, pl.ID)
}

func TestImageReplaceScales(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	version := newProject(t, api, user.Cookie, c.TypeID).Versions[0].ID
	pl := createPlan(t, api, user.Cookie, version, "Ground", 1000, 500)
	lock(t, api, user.Cookie, pl.ID)
	content := getContent(t, api, user.Cookie, pl.ID)
	scale := 0.01
	content.Scale = &scale
	z, p := uuid.New(), uuid.New()
	resp := save(api, user.Cookie, content, []any{zone(z, rect(100, 100, 500, 400)...)}, []any{placement(p, c.Main, 200, 200)})
	wantCode(t, resp, http.StatusOK, "")
	before := decode[plans.PlanContent](t, resp)

	// Twice the size, same aspect ratio.
	resp = multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
		map[string]string{"name": "Ground", "expectedUpdatedAt": pl.UpdatedAt.Format(time.RFC3339Nano)}, pngImage(t, 2000, 1000))
	wantCode(t, resp, http.StatusOK, "")
	replaced := decode[plans.Plan](t, resp)
	if replaced.Image.Width != 2000 || replaced.Image.URL == pl.Image.URL || !replaced.ContentUpdatedAt.After(before.ContentUpdatedAt) {
		t.Errorf("replaced: %+v", replaced)
	}
	// The new image is served under its own URL; the old URL is gone (D211).
	wantCode(t, api.Get(replaced.Image.URL, user.Cookie), http.StatusOK, "")
	wantCode(t, api.Get(pl.Image.URL, user.Cookie), http.StatusNotFound, "plan.image_not_found")
	after := getContent(t, api, user.Cookie, pl.ID)
	got := after.Placements[0]
	if got.X != 400 || got.Y != 400 || got.Width != 40 || got.Height != 40 || got.ZoneID == nil || *got.ZoneID != z {
		t.Errorf("placement after scaling: %+v", got)
	}
	if after.Zones[0].Points[2] != [2]float64{1000, 800} || after.Scale == nil || *after.Scale != 0.005 {
		t.Errorf("zone/scale after scaling: %+v %v", after.Zones[0].Points, after.Scale)
	}

	// Another aspect ratio clears the calibration.
	resp = multipartRequest(t, api, http.MethodPut, "/api/plans/"+pl.ID.String(), user.Cookie,
		map[string]string{"name": "Ground", "expectedUpdatedAt": replaced.UpdatedAt.Format(time.RFC3339Nano)}, pngImage(t, 1000, 1000))
	wantCode(t, resp, http.StatusOK, "")
	after = getContent(t, api, user.Cookie, pl.ID)
	if got := after.Placements[0]; got.X != 200 || got.Y != 400 || after.Scale != nil {
		t.Errorf("after the aspect change: %+v %v", got, after.Scale)
	}
}

func TestVersionCopy(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.TypeID)
	source := p.Versions[0].ID
	pl := createPlan(t, api, user.Cookie, source, "Ground", 1000, 1000)
	createPlan(t, api, user.Cookie, source, "First", 100, 100)
	lock(t, api, user.Cookie, pl.ID)
	z, pid := uuid.New(), uuid.New()
	pp := placement(pid, c.Main, 50, 50)
	pp["instanceValues"] = map[string]any{"address": 3}
	pp["addonVariantIds"] = []string{c.Opt}
	wantCode(t, save(api, user.Cookie, getContent(t, api, user.Cookie, pl.ID), []any{zone(z, rect(0, 0, 100, 100)...)}, []any{pp}), http.StatusOK, "")

	resp := api.Post("/api/projects/"+p.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V2", "sourceVersionId": source})
	wantCode(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	copied := decode[[]plans.Plan](t, api.Get("/api/versions/"+target.String()+"/plans", user.Cookie))
	if len(copied) != 2 || copied[0].Name != "Ground" || copied[1].Name != "First" || copied[0].ID == pl.ID ||
		path.Base(copied[0].Image.URL) != path.Base(pl.Image.URL) || copied[0].Lock != nil {
		t.Fatalf("copied plans: %+v", copied)
	}
	content := getContent(t, api, user.Cookie, copied[0].ID)
	if len(content.Zones) != 1 || len(content.Placements) != 1 {
		t.Fatalf("copied content: %+v", content)
	}
	cz, cp := content.Zones[0], content.Placements[0]
	// Zone and placement ids are kept (D339).
	if cz.ID != z || cp.ID != pid || cp.ZoneID == nil || *cp.ZoneID != cz.ID || cp.InstanceValues["address"] != float64(3) ||
		len(cp.AddonVariantIDs) != 1 {
		t.Errorf("copied zone/placement: %+v %+v", cz, cp)
	}
	// An empty version has no plans.
	resp = api.Post("/api/projects/"+p.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V3"})
	wantCode(t, resp, http.StatusCreated, "")
	empty := decode[struct{ ID uuid.UUID }](t, resp).ID
	if got := decode[[]plans.Plan](t, api.Get("/api/versions/"+empty.String()+"/plans", user.Cookie)); len(got) != 0 {
		t.Errorf("empty version has plans: %+v", got)
	}
	// Changing the copy leaves the source alone.
	if src := getContent(t, api, user.Cookie, pl.ID); src.Placements[0].ID != pid {
		t.Errorf("source changed")
	}
}

// A project moved to another tenant carries its plans along, and their
// images stay readable.
func TestProjectMove(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "zigbee")
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleUser)
	p := newProject(t, api, acmeUser.Cookie, c.TypeID)
	pl := createPlan(t, api, acmeUser.Cookie, p.Versions[0].ID, "Ground", 100, 100)
	lock(t, api, acmeUser.Cookie, pl.ID)
	wantCode(t, save(api, acmeUser.Cookie, getContent(t, api, acmeUser.Cookie, pl.ID),
		[]any{zone(uuid.New(), rect(0, 0, 10, 10)...)}, []any{placement(uuid.New(), c.Main, 5, 5)}), http.StatusOK, "")

	wantCode(t, api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, map[string]any{
		"name": "House", "status": "active", "tenantId": other, "expectedUpdatedAt": p.UpdatedAt,
	}), http.StatusOK, "")
	wantCode(t, api.Get("/api/plans/"+pl.ID.String(), acmeUser.Cookie), http.StatusNotFound, "plan.not_found")
	if got := getContent(t, api, otherUser.Cookie, pl.ID); len(got.Zones) != 1 || len(got.Placements) != 1 {
		t.Errorf("moved content: %+v", got)
	}
	wantCode(t, api.Get(pl.Image.URL, otherUser.Cookie), http.StatusOK, "")
}
