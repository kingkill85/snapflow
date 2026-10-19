package wiring_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring/store"
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
			Code   string `json:"code"`
			Fields []struct {
				Code     string `json:"code"`
				Location string `json:"location"`
			} `json:"fields"`
		}
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		if p.Code != code && (len(p.Fields) == 0 || p.Fields[0].Code != code) {
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

type world struct {
	api           *apptest.API
	user          apptest.Session
	project       uuid.UUID
	version       uuid.UUID
	light, led    uuid.UUID
	dimmerKind    uuid.UUID
	dimmerVariant uuid.UUID
	floor, board  uuid.UUID
	zone, need    uuid.UUID
	module        uuid.UUID
}

func text(en string) map[string]string { return map[string]string{"en": en} }

// setup: function type light (circuits), dimmer outputs serving it, a
// product type KNX, a board product with 2 dimmer channels of 100 W LED, a
// project with a floorplan (zone with a need of 3 × 40 W LED) and a board
// with one dimmer.
func setup(t *testing.T) world {
	t.Helper()
	api := apptest.New(t)
	w := world{api: api}
	admin := api.Admin.Cookie
	post := func(path string, body map[string]any) uuid.UUID {
		t.Helper()
		resp := api.Post(path, admin, body)
		want(t, resp, http.StatusCreated, "")
		return decode[struct{ ID uuid.UUID }](t, resp).ID
	}
	w.light = post("/api/function-types", map[string]any{"key": "light", "name": text("Light"), "allowsCircuit": true})
	// The test database has no seeded catalog configuration.
	w.led = post("/api/load-types", map[string]any{"key": "led", "name": text("LED"), "isActive": true})
	w.dimmerKind = post("/api/output-kinds", map[string]any{"key": "dimmer_output", "name": text("Dimmer output"), "isActive": true,
		"functionTypeIds": []any{w.light}})
	knx := post("/api/product-types", map[string]any{"key": "knx", "name": text("KNX"), "isActive": true, "topology": "none"})
	post("/api/catalog-fields", map[string]any{"key": "dim_ch", "label": text("Dimmer channels"), "type": "integer", "meaning": "channels_supplied",
		"outputKindId": w.dimmerKind})
	post("/api/catalog-fields", map[string]any{"key": "dim_led_w", "label": text("LED W"), "type": "number", "meaning": "channel_limit_w",
		"outputKindId": w.dimmerKind, "loadTypeId": w.led})
	post("/api/catalog-fields", map[string]any{"key": "width_te", "label": text("Width"), "type": "number", "meaning": "rail_width_te"})
	attrs := []any{}
	for _, k := range []string{"dim_ch", "dim_led_w", "width_te"} {
		typ := "number"
		if k == "dim_ch" {
			typ = "integer"
		}
		attrs = append(attrs, map[string]any{"key": k, "label": text(k), "type": typ, "fieldKey": k})
	}
	cat := post("/api/categories", map[string]any{"key": "actuators", "name": text("Actuators"), "isActive": true, "mounting": "board",
		"attributes": attrs, "instanceAttributes": []any{}})
	p := post("/api/products", map[string]any{"productTypeId": knx, "categoryId": cat, "modelNumber": "DIM", "name": text("Dimmer"), "isActive": true,
		"attributes": map[string]any{"dim_ch": 2, "dim_led_w": 100, "width_te": 4}})
	w.dimmerVariant = post("/api/products/"+p.String()+"/variants", map[string]any{"name": text("DIM"), "price": "10.00", "isActive": true})

	w.user = api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	resp := api.Post("/api/projects", w.user.Cookie, map[string]any{"name": "House", "productTypeIds": []any{knx}})
	want(t, resp, http.StatusCreated, "")
	pr := decode[struct {
		ID       uuid.UUID
		Versions []struct{ ID uuid.UUID }
	}](t, resp)
	w.project, w.version = pr.ID, pr.Versions[0].ID

	// Floorplan with a zone and a need.
	w.floor = w.floorplan(t)
	w.zone, w.need = uuid.New(), uuid.New()
	want(t, api.Post("/api/plans/"+w.floor.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	c := decode[plans.PlanContent](t, api.Get("/api/plans/"+w.floor.String()+"/content", w.user.Cookie))
	want(t, api.Put("/api/plans/"+w.floor.String()+"/content", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "placements": []any{},
		"zones": []any{map[string]any{"id": w.zone, "name": "Kitchen", "color": "#aabbcc", "opacity": 0.3, "points": [][2]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}}}},
		"needs": []any{map[string]any{"id": w.need, "zoneId": w.zone, "functionTypeId": w.light, "quantity": 3, "powerW": "40", "loadTypeId": w.led,
			"label": "Spots", "note": "", "x": nil, "y": nil}},
	}), http.StatusOK, "")

	// Board with one dimmer.
	resp = api.Post("/api/versions/"+w.version.String()+"/boards", w.user.Cookie, map[string]any{"name": "Board", "rows": []any{map[string]any{"capacityTe": 24}}})
	want(t, resp, http.StatusCreated, "")
	w.board = decode[plans.Plan](t, resp).ID
	want(t, api.Post("/api/plans/"+w.board.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	b := decode[plans.BoardContent](t, api.Get("/api/plans/"+w.board.String()+"/board", w.user.Cookie))
	w.module = uuid.New()
	want(t, api.Put("/api/plans/"+w.board.String()+"/board", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil, "rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 24}},
		"modules": []any{map[string]any{"id": w.module, "rowId": b.Rows[0].ID, "offsetTe": 0, "variantId": w.dimmerVariant, "label": "",
			"existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}}}}), http.StatusOK, "")
	return w
}

func (w world) floorplan(t *testing.T) uuid.UUID {
	t.Helper()
	var png1 bytes.Buffer
	if err := png.Encode(&png1, image.NewNRGBA(image.Rect(0, 0, 10, 10))); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("name", "Ground")
	part, _ := mw.CreateFormFile("image", "plan.png")
	_, _ = part.Write(png1.Bytes())
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/versions/"+w.version.String()+"/plans", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Cookie", w.user.Cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	w.api.Adapter().ServeHTTP(resp, req)
	want(t, resp, http.StatusCreated, "")
	return decode[plans.Plan](t, resp).ID
}

func (w world) url(rest string) string { return "/api/versions/" + w.version.String() + rest }

func (w world) connect(units int, channel int) map[string]any {
	return map[string]any{"needPlanId": w.floor, "needId": w.need, "units": units, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": channel}
}

func (w world) checks(t *testing.T) wiring.Checks {
	t.Helper()
	resp := w.api.Get(w.url("/checks"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	return decode[wiring.Checks](t, resp)
}

func TestConnections(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie

	list := decode[wiring.Connections](t, api.Get(w.url("/connections"), cookie))
	if len(list.Items) != 0 || !list.Can.Update {
		t.Fatalf("list %+v", list)
	}
	if z := w.checks(t).Zones; len(z) != 1 || z[0].Status != "missing" || z[0].Units != 3 {
		t.Fatalf("zones %+v", z)
	}

	// Two units on channel 1 (80 W of 100 W LED).
	resp := api.Post(w.url("/connections"), cookie, w.connect(2, 1))
	want(t, resp, http.StatusCreated, "")
	first := decode[wiring.ConnectionResult](t, resp).Connection
	if !first.Pinned || first.Units != 2 || first.BatchID != nil {
		t.Fatalf("connection %+v", first)
	}
	// Refused: units above the quantity, the channel's W limit, a missing
	// channel, a need of another plan.
	want(t, api.Post(w.url("/connections"), cookie, w.connect(2, 2)), http.StatusUnprocessableEntity, "connection.units_exceeded")
	want(t, api.Post(w.url("/connections"), cookie, w.connect(1, 1)), http.StatusUnprocessableEntity, "connection.channel_overload_w")
	want(t, api.Post(w.url("/connections"), cookie, w.connect(1, 3)), http.StatusUnprocessableEntity, "connection.channel_not_found")
	bad := w.connect(1, 2)
	bad["needId"] = uuid.New()
	want(t, api.Post(w.url("/connections"), cookie, bad), http.StatusUnprocessableEntity, "connection.need_not_found")
	if z := w.checks(t).Zones; z[0].Status != "partial" || z[0].ConnectedUnits != 2 {
		t.Fatalf("zones %+v", z)
	}

	// Move it to channel 2 with 1 unit (pinned stays).
	resp = api.Put(w.url("/connections/"+first.ID.String()), cookie, map[string]any{"units": 1, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 2})
	want(t, resp, http.StatusOK, "")
	if c := decode[wiring.ConnectionResult](t, resp).Connection; c.ChannelNo != 2 || c.Units != 1 {
		t.Fatalf("moved %+v", c)
	}
	want(t, api.Put(w.url("/connections/"+uuid.New().String()), cookie, map[string]any{"units": 1, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 2}), http.StatusNotFound, "connection.not_found")

	// Auto-connect: 2 units left; channel 2 holds 40 W, the circuit takes
	// both (120 W > 100 W → 1 unit), the second goes to channel 1.
	resp = api.Post(w.url("/auto-connect/preview"), cookie, map[string]any{"scope": "all"})
	want(t, resp, http.StatusOK, "")
	preview := decode[wiring.AutoConnectPreview](t, resp)
	if len(preview.Connections) != 2 || preview.ConnectedUnits != 2 || preview.Connections[0].ChannelNo != 2 || preview.Connections[1].ChannelNo != 1 {
		t.Fatalf("preview %+v", preview)
	}
	again := decode[wiring.AutoConnectPreview](t, api.Post(w.url("/auto-connect/preview"), cookie, map[string]any{"scope": "all"}))
	if again.Checksum != preview.Checksum {
		t.Fatal("preview not deterministic")
	}
	want(t, api.Post(w.url("/auto-connect/apply"), cookie, map[string]any{"scope": "all", "expectedChecksum": "x"}), http.StatusConflict, "auto_connect.changed")
	resp = api.Post(w.url("/auto-connect/apply"), cookie, map[string]any{"scope": "all", "expectedChecksum": preview.Checksum})
	want(t, resp, http.StatusOK, "")
	applied := decode[wiring.AutoConnectResult](t, resp)
	if applied.BatchID == nil || len(applied.Connections) != 2 || applied.Connections[0].Pinned {
		t.Fatalf("applied %+v", applied)
	}
	c := w.checks(t)
	if c.Zones[0].Status != "covered" || c.Counts.ZonesCovered != 1 || c.Counts.Errors != 0 {
		t.Fatalf("checks %+v", c)
	}
	if ch := c.Boards[0].Channels[0]; ch.Total != 2 || ch.Used != 2 || ch.Free != 0 {
		t.Fatalf("board %+v", c.Boards[0])
	}

	// A batch row changed by hand leaves the batch; undo removes the rest.
	moved := applied.Connections[1]
	want(t, api.Put(w.url("/connections/"+moved.ID.String()), cookie, map[string]any{"units": 1, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 1}), http.StatusOK, "")
	resp = api.Delete(w.url("/auto-connect/"+applied.BatchID.String()), cookie)
	want(t, resp, http.StatusOK, "")
	if r := decode[wiring.Removed](t, resp); r.Removed != 1 {
		t.Fatalf("undo %+v", r)
	}
	list = decode[wiring.Connections](t, api.Get(w.url("/connections"), cookie))
	if len(list.Items) != 2 {
		t.Fatalf("after undo %+v", list.Items)
	}

	// Version copy: connections with plan ids mapped, no batch.
	resp = api.Post("/api/projects/"+w.project.String()+"/versions", cookie, map[string]any{"name": "V2", "sourceVersionId": w.version})
	want(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	copied := decode[wiring.Connections](t, api.Get("/api/versions/"+target.String()+"/connections", cookie))
	if len(copied.Items) != 2 || copied.Items[0].NeedPlanID == w.floor || copied.Items[0].TargetPlanID == w.board || copied.Items[0].NeedID != w.need ||
		copied.Items[0].TargetItemID != w.module {
		t.Fatalf("copied %+v", copied.Items)
	}
	cc := decode[wiring.Checks](t, api.Get("/api/versions/"+target.String()+"/checks", cookie))
	if cc.Zones[0].Status != "partial" || cc.Zones[0].ConnectedUnits != 2 {
		t.Fatalf("copied checks %+v", cc.Zones)
	}

	// A module removed leaves its connections dangling (reported).
	b := decode[plans.BoardContent](t, api.Get("/api/plans/"+w.board.String()+"/board", cookie))
	want(t, api.Put("/api/plans/"+w.board.String()+"/board", cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil, "rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 24}},
		"modules": []any{}}), http.StatusOK, "")
	c = w.checks(t)
	n := 0
	for _, f := range c.Findings {
		if f.Code == wiring.CodeTargetNotFound {
			n++
		}
	}
	if n != 2 || c.Counts.Errors != 2 {
		t.Fatalf("dangling %+v", c.Findings)
	}

	// Disconnect the need; delete a missing connection.
	resp = api.Post(w.url("/connections/disconnect"), cookie, map[string]any{"needPlanId": w.floor, "needId": w.need})
	want(t, resp, http.StatusOK, "")
	if r := decode[wiring.Removed](t, resp); r.Removed != 2 {
		t.Fatalf("disconnect %+v", r)
	}
	want(t, api.Post(w.url("/connections/disconnect"), cookie, map[string]any{}), http.StatusUnprocessableEntity, "connection.disconnect_target")
	want(t, api.Delete(w.url("/connections/"+first.ID.String()), cookie), http.StatusNotFound, "connection.not_found")

	// Another tenant sees nothing.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	want(t, api.Get(w.url("/connections"), other.Cookie), http.StatusNotFound, "")
	want(t, api.Get(w.url("/checks"), other.Cookie), http.StatusNotFound, "")
	want(t, api.Post(w.url("/connections"), other.Cookie, w.connect(1, 1)), http.StatusNotFound, "")
}

func TestReadOnly(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	resp := api.Post(w.url("/connections"), cookie, w.connect(1, 1))
	want(t, resp, http.StatusCreated, "")
	id := decode[wiring.ConnectionResult](t, resp).Connection.ID
	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{
		"name": p.Name, "status": "completed", "expectedUpdatedAt": p.UpdatedAt}), http.StatusOK, "")
	if l := decode[wiring.Connections](t, api.Get(w.url("/connections"), cookie)); l.Can.Update || len(l.Items) != 1 {
		t.Fatalf("list %+v", l)
	}
	w.checks(t)
	want(t, api.Post(w.url("/connections"), cookie, w.connect(1, 2)), http.StatusConflict, "project.read_only")
	want(t, api.Delete(w.url("/connections/"+id.String()), cookie), http.StatusConflict, "project.read_only")
	want(t, api.Post(w.url("/auto-connect/preview"), cookie, map[string]any{"scope": "all"}), http.StatusOK, "")
	want(t, api.Post(w.url("/auto-connect/apply"), cookie, map[string]any{"scope": "all", "expectedChecksum": ""}), http.StatusConflict, "project.read_only")
	want(t, api.Post(w.url("/connections/disconnect"), cookie, map[string]any{"needPlanId": w.floor, "needId": w.need}), http.StatusConflict, "project.read_only")
}

// Row-level security on connections.
func TestConnectionsRowLevelSecurity(t *testing.T) {
	w := setup(t)
	ctx := t.Context()
	want(t, w.api.Post(w.url("/connections"), w.user.Cookie, w.connect(1, 1)), http.StatusCreated, "")
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
	if rows, err := q.ListConnections(ctx, w.version); err != nil || len(rows) != 0 {
		t.Errorf("foreign connections: %v %v", rows, err)
	}
	if n, err := q.DeleteNeedConnections(ctx, store.DeleteNeedConnectionsParams{VersionID: w.version, NeedPlanID: w.floor, NeedID: w.need}); err != nil || n != 0 {
		t.Errorf("foreign delete: %d %v", n, err)
	}
	_, err = q.CreateConnection(ctx, store.CreateConnectionParams{TenantID: w.user.TenantID, VersionID: w.version, NeedPlanID: w.floor, NeedID: w.need,
		Units: 1, TargetPlanID: w.board, TargetItemID: w.module, OutputKindID: w.dimmerKind, ChannelNo: 1, Pinned: true})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Errorf("connection in another tenant: %v", err)
	}
}

// The nominal voltage of a product type: default 230, kept when left out.
func TestNominalVoltage(t *testing.T) {
	api := apptest.New(t)
	resp := api.Post("/api/product-types", api.Admin.Cookie, map[string]any{"key": "hdl", "name": text("HDL"), "isActive": true})
	want(t, resp, http.StatusCreated, "")
	pt := decode[struct {
		ID             uuid.UUID
		NominalVoltage int32
		UpdatedAt      time.Time
	}](t, resp)
	if pt.NominalVoltage != 230 {
		t.Fatalf("default %d", pt.NominalVoltage)
	}
	resp = api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{"key": "hdl", "name": text("HDL"), "isActive": true,
		"nominalVoltage": 110, "expectedUpdatedAt": pt.UpdatedAt})
	want(t, resp, http.StatusOK, "")
	pt2 := decode[struct {
		NominalVoltage int32
		UpdatedAt      time.Time
	}](t, resp)
	resp = api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{"key": "hdl", "name": text("HDL"), "isActive": true,
		"expectedUpdatedAt": pt2.UpdatedAt})
	want(t, resp, http.StatusOK, "")
	if v := decode[struct{ NominalVoltage int32 }](t, resp).NominalVoltage; pt2.NominalVoltage != 110 || v != 110 {
		t.Fatalf("voltage %d %d", pt2.NominalVoltage, v)
	}
	want(t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{"key": "hdl", "name": text("HDL"), "isActive": true,
		"nominalVoltage": 5000, "expectedUpdatedAt": pt2.UpdatedAt}), http.StatusUnprocessableEntity, "")
}
