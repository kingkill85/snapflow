package networks_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/networks/store"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func want(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d: %s", resp.Code, status, resp.Body)
	}
	if code != "" {
		var p struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		if p.Code != code {
			t.Fatalf("code %q, want %q: %s", p.Code, code, resp.Body)
		}
	}
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode: %v: %s", err, resp.Body)
	}
	return v
}

// createFloorplan posts a 10×10 PNG plan.
func createFloorplan(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string) *httptest.ResponseRecorder {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 10, 10))
	img.Set(0, 0, color.NRGBA{R: 200, A: 255})
	var png1 bytes.Buffer
	if err := png.Encode(&png1, img); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	_ = w.WriteField("name", name)
	part, err := w.CreateFormFile("image", "plan.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(png1.Bytes())
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/versions/"+versionID.String()+"/plans", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	return resp
}

type world struct {
	api     *apptest.API
	c       apptest.BoardCatalog
	user    apptest.Session
	project uuid.UUID
	version uuid.UUID
}

func setup(t *testing.T) world {
	api := apptest.New(t)
	c := api.NewBoardCatalog()
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	resp := api.Post("/api/projects", user.Cookie, map[string]any{"name": "House", "productTypeIds": []any{c.KNX, c.Zigbee}})
	want(t, resp, http.StatusCreated, "")
	p := decode[struct {
		ID       uuid.UUID
		Versions []struct{ ID uuid.UUID }
	}](t, resp)
	return world{api: api, c: c, user: user, project: p.ID, version: p.Versions[0].ID}
}

func (w world) board(t *testing.T, name string, modules ...[2]uuid.UUID) uuid.UUID {
	t.Helper()
	resp := w.api.Post("/api/versions/"+w.version.String()+"/boards", w.user.Cookie, map[string]any{"name": name, "rows": []any{map[string]any{"capacityTe": 24}}})
	want(t, resp, http.StatusCreated, "")
	id := decode[plans.Plan](t, resp).ID
	want(t, w.api.Post("/api/plans/"+id.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	b := decode[plans.BoardContent](t, w.api.Get("/api/plans/"+id.String()+"/board", w.user.Cookie))
	list := []any{}
	for i, m := range modules {
		list = append(list, map[string]any{"id": m[0], "rowId": b.Rows[0].ID, "offsetTe": float64(i * 4), "variantId": m[1], "label": "",
			"existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}})
	}
	want(t, w.api.Put("/api/plans/"+id.String()+"/board", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil, "rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 24}},
		"modules": list}), http.StatusOK, "")
	return id
}

// floorplan adds a plan with placements (id, variant).
func (w world) floorplan(t *testing.T, name string, items ...[2]uuid.UUID) uuid.UUID {
	t.Helper()
	resp := createFloorplan(t, w.api, w.user.Cookie, w.version, name)
	want(t, resp, http.StatusCreated, "")
	pl := decode[plans.Plan](t, resp)
	want(t, w.api.Post("/api/plans/"+pl.ID.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	content := decode[plans.PlanContent](t, w.api.Get("/api/plans/"+pl.ID.String()+"/content", w.user.Cookie))
	list := []any{}
	for _, it := range items {
		list = append(list, map[string]any{"id": it[0], "variantId": it[1], "x": 5, "y": 5, "width": 1, "height": 1, "rotation": 0,
			"label": "", "existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}})
	}
	want(t, w.api.Put("/api/plans/"+pl.ID.String()+"/content", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": content.ContentUpdatedAt, "scale": nil, "zones": []any{}, "placements": list}), http.StatusOK, "")
	return pl.ID
}

func TestNetworks(t *testing.T) {
	w := setup(t)
	api, cookie, v := w.api, w.user.Cookie, w.version.String()
	act, psu, sensor, gw1, gw2, bulb1, bulb2, bulb3 := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ground := w.floorplan(t, "Ground", [2]uuid.UUID{sensor, w.c.Sensor}, [2]uuid.UUID{gw1, w.c.Gateway}, [2]uuid.UUID{bulb1, w.c.Bulb})
	first := w.floorplan(t, "First", [2]uuid.UUID{bulb2, w.c.Bulb})
	second := w.floorplan(t, "Second", [2]uuid.UUID{gw2, w.c.Gateway}, [2]uuid.UUID{bulb3, w.c.Bulb})
	board := w.board(t, "Board", [2]uuid.UUID{act, w.c.Actuator}, [2]uuid.UUID{psu, w.c.PSU})

	// The first GET creates the default line of KNX; every bus device is on it.
	n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
	if len(n.BusSystems) != 1 || len(n.BusSystems[0].Lines) != 1 || n.BusSystems[0].Lines[0].Name != "KNX 1" {
		t.Fatalf("bus systems: %+v", n.BusSystems)
	}
	line1 := n.BusSystems[0].Lines[0]
	if line1.DeviceCount != 3 || line1.BusCurrentUsedMa != 15 || line1.BusCurrentSuppliedMa != 640 || line1.UnknownCurrentCount != 0 {
		t.Errorf("line 1: %+v", line1)
	}
	// Gateways: bulb1 same plan (gw1); bulb2 on First is as near to Ground
	// as to Second: the earlier plan (gw1); bulb3 same plan (gw2).
	if len(n.WirelessSystems) != 1 || len(n.WirelessSystems[0].Gateways) != 2 {
		t.Fatalf("wireless: %+v", n.WirelessSystems)
	}
	g1, g2 := n.WirelessSystems[0].Gateways[0], n.WirelessSystems[0].Gateways[1]
	if g1.ItemID != gw1 || len(g1.Devices) != 2 || g1.Devices[0].ItemID != bulb1 || g1.Devices[1].ItemID != bulb2 || g1.WirelessPlacesUsed != 2 ||
		g2.ItemID != gw2 || len(g2.Devices) != 1 || g2.Devices[0].ItemID != bulb3 {
		t.Errorf("gateways: %+v", n.WirelessSystems[0].Gateways)
	}

	// Bus lines CRUD.
	resp := api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "Line 2", "address": "1.2"})
	want(t, resp, http.StatusCreated, "")
	line2 := decode[networks.BusLine](t, resp)
	want(t, api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "line 2"}), http.StatusConflict, "bus_line.name_taken")
	want(t, api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.Zigbee, "name": "Z"}), http.StatusUnprocessableEntity, "")
	resp = api.Put("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie, map[string]any{"name": "Upstairs", "address": "1.3"})
	want(t, resp, http.StatusOK, "")

	// Explicit assignments: the PSU to line 2, bulb2 to gw2.
	resp = api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": psu, "busLineId": line2.ID},
		map[string]any{"planId": first, "itemId": bulb2, "gatewayPlanId": second, "gatewayItemId": gw2},
	}})
	want(t, resp, http.StatusOK, "")
	n = decode[networks.Networks](t, resp)
	l1, l2 := n.BusSystems[0].Lines[0], n.BusSystems[0].Lines[1]
	if l1.DeviceCount != 2 || l2.DeviceCount != 1 || !l2.Members[0].Pinned || !l2.Members[0].PowerSupply || l1.Members[0].Pinned ||
		l2.Name != "Upstairs" || l2.Address != "1.3" {
		t.Errorf("lines: %+v %+v", l1, l2)
	}
	if g := n.WirelessSystems[0].Gateways[1]; len(g.Devices) != 2 || g.Devices[0].ItemID != bulb2 || !g.Devices[0].Pinned {
		t.Errorf("gw2: %+v", g)
	}
	// Invalid assignments.
	resp = api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": ground, "itemId": bulb1, "busLineId": line2.ID},
		map[string]any{"planId": ground, "itemId": sensor, "gatewayPlanId": ground, "gatewayItemId": gw1},
		map[string]any{"planId": ground, "itemId": uuid.New(), "busLineId": line2.ID},
		map[string]any{"planId": first, "itemId": bulb2, "gatewayPlanId": ground, "gatewayItemId": bulb1},
	}})
	want(t, resp, http.StatusUnprocessableEntity, "")
	// A line with assigned devices cannot be deleted.
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie), http.StatusConflict, "bus_line.in_use")

	// Version copy keeps line ids and assignments (plan ids mapped).
	resp = api.Post("/api/projects/"+w.project.String()+"/versions", cookie, map[string]any{"name": "V2", "sourceVersionId": w.version})
	want(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	cn := decode[networks.Networks](t, api.Get("/api/versions/"+target.String()+"/networks", cookie))
	if len(cn.BusSystems[0].Lines) != 2 || cn.BusSystems[0].Lines[1].ID != line2.ID || len(cn.BusSystems[0].Lines[1].Members) != 1 ||
		cn.BusSystems[0].Lines[1].Members[0].ItemID != psu || cn.BusSystems[0].Lines[1].Members[0].PlanID == board {
		t.Errorf("copied lines: %+v", cn.BusSystems[0].Lines)
	}
	if g := cn.WirelessSystems[0].Gateways[1]; len(g.Devices) != 2 || !g.Devices[0].Pinned {
		t.Errorf("copied gateways: %+v", g)
	}

	// Clearing an assignment returns the default; then the line can go.
	want(t, api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": psu}}}), http.StatusOK, "")
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie), http.StatusNoContent, "")

	// Reorder: every line once.
	lines := decode[[]networks.BusLine](t, api.Get("/api/versions/"+v+"/bus-lines", cookie))
	want(t, api.Put("/api/versions/"+v+"/bus-lines/order", cookie, map[string]any{"ids": []any{}}), http.StatusUnprocessableEntity, "bus_line.order_mismatch")
	want(t, api.Put("/api/versions/"+v+"/bus-lines/order", cookie, map[string]any{"ids": []any{lines[0].ID}}), http.StatusOK, "")

	// Another tenant sees nothing.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	want(t, api.Get("/api/versions/"+v+"/networks", other.Cookie), http.StatusNotFound, "")
	want(t, api.Get("/api/versions/"+v+"/bus-lines", other.Cookie), http.StatusNotFound, "")
}

// Row-level security on bus_lines and network_assignments.
func TestNetworksRowLevelSecurity(t *testing.T) {
	w := setup(t)
	ctx := t.Context()
	act := uuid.New()
	board := w.board(t, "Board", [2]uuid.UUID{act, w.c.Actuator})
	n := decode[networks.Networks](t, w.api.Get("/api/versions/"+w.version.String()+"/networks", w.user.Cookie))
	lineID := n.BusSystems[0].Lines[0].ID
	want(t, w.api.Put("/api/versions/"+w.version.String()+"/network-assignments", w.user.Cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": act, "busLineId": lineID}}}), http.StatusOK, "")

	intruderTenant := w.api.NewTenant("Intruder")
	intruder := w.api.NewUser(intruderTenant, auth.RoleUser)
	tx, err := w.api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := database.SetScope(ctx, tx, auth.Actor{UserID: intruder.UserID, TenantID: intruderTenant, Role: auth.RoleUser}); err != nil {
		t.Fatal(err)
	}
	q := store.New(tx)
	if rows, err := q.ListBusLines(ctx, w.version); err != nil || len(rows) != 0 {
		t.Errorf("foreign lines: %v %v", rows, err)
	}
	if rows, err := q.ListAssignments(ctx, w.version); err != nil || len(rows) != 0 {
		t.Errorf("foreign assignments: %v %v", rows, err)
	}
	if n, err := q.DeleteBusLine(ctx, store.DeleteBusLineParams{VersionID: w.version, ID: lineID}); err != nil || n != 0 {
		t.Errorf("foreign delete: %d %v", n, err)
	}
	_, err = q.CreateBusLine(ctx, store.CreateBusLineParams{TenantID: w.user.TenantID, VersionID: w.version, ProductTypeID: w.c.KNX, Name: "Planted"})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Errorf("line in another tenant: %v", err)
	}
}
