package readiness_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/readiness"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func send[T any](t *testing.T, resp *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d: %s", resp.Code, status, resp.Body)
	}
	return decode[T](t, resp)
}

func create[T any](t *testing.T, api *apptest.API, path string, body any) T {
	t.Helper()
	return send[T](t, api.Post(path, api.Admin.Cookie, body), http.StatusCreated)
}

func name(en string) map[string]string { return map[string]string{"en": en} }

func get(t *testing.T, api *apptest.API) readiness.Readiness {
	t.Helper()
	return send[readiness.Readiness](t, api.Get("/api/catalog/readiness", api.Admin.Cookie), http.StatusOK)
}

// codes maps code to its item.
func codes(list []readiness.ReadinessItem) map[string]readiness.ReadinessItem {
	out := map[string]readiness.ReadinessItem{}
	for _, it := range list {
		out[it.Code] = it
	}
	return out
}

func system(t *testing.T, r readiness.Readiness, key string) map[string]readiness.ReadinessItem {
	t.Helper()
	for _, s := range r.Systems {
		if s.Key == key {
			return codes(s.Items)
		}
	}
	t.Fatalf("no system %q in %+v", key, r.Systems)
	return nil
}

func refIDs(it readiness.ReadinessItem) []uuid.UUID {
	out := []uuid.UUID{}
	for _, r := range it.Refs {
		out = append(out, r.ID)
	}
	return out
}

func expectItem(t *testing.T, items map[string]readiness.ReadinessItem, code string, sev readiness.Severity, count int, refs ...uuid.UUID) {
	t.Helper()
	it, ok := items[code]
	if !ok {
		t.Errorf("%s missing in %+v", code, items)
		return
	}
	if it.Severity != sev || it.Count != count {
		t.Errorf("%s: %s %d, want %s %d", code, it.Severity, it.Count, sev, count)
	}
	got := refIDs(it)
	if len(got) != len(refs) {
		t.Errorf("%s refs %v, want %v", code, got, refs)
		return
	}
	for i := range refs {
		if got[i] != refs[i] {
			t.Errorf("%s refs %v, want %v", code, got, refs)
		}
	}
}

func expectNone(t *testing.T, items map[string]readiness.ReadinessItem, codes ...string) {
	t.Helper()
	for _, c := range codes {
		if it, ok := items[c]; ok {
			t.Errorf("%s unexpected: %+v", c, it)
		}
	}
}

type world struct {
	knx, zigbee, plain, off producttypes.ProductType
	dimmer, relay           capabilities.OutputKind
	board, sensors, infra   categories.Category
}

func attr(key, typ, fieldKey string) map[string]any {
	return map[string]any{"key": key, "label": name(key), "type": typ, "fieldKey": fieldKey}
}

func setup(t *testing.T, api *apptest.API) world {
	var w world
	pt := func(key string, extra map[string]any) producttypes.ProductType {
		b := map[string]any{"key": key, "name": name(key), "isActive": true}
		for k, v := range extra {
			b[k] = v
		}
		return create[producttypes.ProductType](t, api, "/api/product-types", b)
	}
	w.knx = pt("knx", map[string]any{"topology": "bus", "addressing": "knx_individual"})
	w.zigbee = pt("zigbee", map[string]any{"topology": "wireless", "addressing": "eui64"})
	w.plain = pt("plain", map[string]any{"topology": "none"})
	w.off = pt("off", map[string]any{"topology": "none", "isActive": false})
	kind := func(key string) capabilities.OutputKind {
		return create[capabilities.OutputKind](t, api, "/api/output-kinds", map[string]any{"key": key, "name": name(key), "isActive": true})
	}
	w.dimmer, w.relay = kind("dimmer_output"), kind("relay_output")
	led := create[capabilities.LoadType](t, api, "/api/load-types", map[string]any{"key": "led", "name": name("LED"), "isActive": true})
	field := func(b map[string]any) {
		b["label"] = name(b["key"].(string))
		create[capabilities.CatalogField](t, api, "/api/catalog-fields", b)
	}
	field(map[string]any{"key": "dimmer_outputs", "type": "integer", "meaning": "channels_supplied", "outputKindId": w.dimmer.ID})
	field(map[string]any{"key": "dimmer_led_w", "type": "number", "meaning": "channel_limit_w", "outputKindId": w.dimmer.ID, "loadTypeId": led.ID})
	field(map[string]any{"key": "bus_ma", "type": "number", "meaning": "bus_current_used_ma"})
	field(map[string]any{"key": "supply_ma", "type": "number", "meaning": "bus_current_supplied_ma"})
	field(map[string]any{"key": "width_te", "type": "number", "meaning": "rail_width_te"})
	field(map[string]any{"key": "rows", "type": "integer", "meaning": "enclosure_rows"})
	field(map[string]any{"key": "places", "type": "integer", "meaning": "wireless_places_supplied"})
	cat := func(key, mounting string, channels bool) categories.Category {
		attrs := []any{attr("bus", "number", "bus_ma"), attr("supply", "number", "supply_ma"), attr("width", "number", "width_te"),
			attr("rows", "integer", "rows"), attr("places", "integer", "places")}
		if channels {
			attrs = append(attrs, attr("dimmers", "integer", "dimmer_outputs"), attr("dimmer_led", "number", "dimmer_led_w"))
		}
		return create[categories.Category](t, api, "/api/categories", map[string]any{"key": key, "name": name(key), "isActive": true,
			"mounting": mounting, "instanceAttributes": []any{}, "attributes": attrs})
	}
	w.board, w.sensors, w.infra = cat("board", "board", true), cat("sensors", "floorplan", false), cat("infra", "board", false)
	return w
}

func product(t *testing.T, api *apptest.API, typeID, catID uuid.UUID, model string, attrs map[string]any, active bool) products.Product {
	return create[products.Product](t, api, "/api/products", map[string]any{"productTypeId": typeID, "categoryId": catID,
		"modelNumber": model, "name": name(model), "isActive": active, "attributes": attrs})
}

func missing(p products.Product) []string {
	out := []string{}
	for _, m := range p.Capabilities.Missing {
		out = append(out, string(m.Code))
	}
	return out
}

func TestReadiness(t *testing.T) {
	api := apptest.New(t)
	// An empty catalog: no function at all.
	empty := get(t, api)
	expectItem(t, codes(empty.Global), "functions_none", readiness.SeverityError, 1)

	w := setup(t, api)
	served := create[map[string]any](t, api, "/api/function-types", map[string]any{"key": "dimmer", "name": name("Dimmer"),
		"outputKindIds": []any{w.dimmer.ID}, "knxObjects": []any{map[string]any{"key": "switch", "name": name("Switch"), "dpst": "DPST-1-1"}}})
	lonely := create[map[string]any](t, api, "/api/function-types", map[string]any{"key": "socket", "name": name("Socket")})
	lonelyID := uuid.MustParse(lonely["id"].(string))
	servedID := uuid.MustParse(served["id"].(string))

	a1 := product(t, api, w.knx.ID, w.board.ID, "A-1", map[string]any{"dimmers": 4}, true)
	a2 := product(t, api, w.knx.ID, w.board.ID, "A-2", map[string]any{"bus": 10, "width": 4, "dimmer_led": 300}, true)
	product(t, api, w.knx.ID, w.board.ID, "A-3", map[string]any{}, false) // inactive: skipped
	s1 := product(t, api, w.zigbee.ID, w.sensors.ID, "S-1", map[string]any{"width": 1}, true)

	r := get(t, api)
	global := codes(r.Global)
	expectNone(t, global, "functions_none")
	expectItem(t, global, "function_not_served", readiness.SeverityError, 1, lonelyID)
	expectItem(t, global, "function_no_load_types", readiness.SeverityInfo, 2, servedID, lonelyID)
	expectItem(t, global, "function_no_knx_objects", readiness.SeverityWarning, 1, lonelyID)
	expectItem(t, global, "channel_kind_unused", readiness.SeverityInfo, 1, w.relay.ID)
	expectItem(t, global, "categories_without_mounting_board", readiness.SeverityWarning, 1, w.sensors.ID)
	if r.Global[0].Severity != readiness.SeverityError {
		t.Errorf("errors first: %+v", r.Global)
	}

	for _, s := range r.Systems {
		if s.Key == "off" {
			t.Errorf("inactive system listed")
		}
	}
	knx := system(t, r, "knx")
	expectItem(t, knx, "product_board_without_width", readiness.SeverityError, 1, a1.ID)
	expectItem(t, knx, "product_channels_missing", readiness.SeverityWarning, 1, a2.ID)
	expectItem(t, knx, "product_bus_current_missing", readiness.SeverityWarning, 1, a1.ID)
	expectItem(t, knx, "product_channel_without_limit", readiness.SeverityInfo, 1, a1.ID)
	expectItem(t, knx, "system_no_power_supply", readiness.SeverityWarning, 1)
	expectItem(t, knx, "system_no_enclosure", readiness.SeverityInfo, 1)
	expectNone(t, knx, "topology_none", "system_no_gateway")
	if got := missing(a1); len(got) != 3 || got[0] != "product_board_without_width" {
		t.Errorf("A-1 missing %v", got)
	}
	if got := missing(a2); len(got) != 1 || got[0] != "product_channels_missing" {
		t.Errorf("A-2 missing %v", got)
	}

	zb := system(t, r, "zigbee")
	expectItem(t, zb, "system_no_gateway", readiness.SeverityWarning, 1)
	expectNone(t, zb, "system_no_enclosure", "product_bus_current_missing", "product_board_without_width")
	if len(missing(s1)) != 0 {
		t.Errorf("S-1 missing %v", missing(s1))
	}
	expectItem(t, system(t, r, "plain"), "topology_none", readiness.SeverityInfo, 1)

	// Fixing the catalog clears the items: a power supply, an enclosure, a
	// gateway, A-1's width, bus current and limit, A-2's channels; a default
	// bus current would also have done.
	product(t, api, w.knx.ID, w.infra.ID, "PS-1", map[string]any{"supply": 640, "width": 4}, true)
	product(t, api, w.knx.ID, w.infra.ID, "ENC-1", map[string]any{"rows": 3}, true)
	product(t, api, w.zigbee.ID, w.sensors.ID, "GW-1", map[string]any{"places": 64}, true)
	fixed := send[products.Product](t, api.Put("/api/products/"+a1.ID.String(), api.Admin.Cookie, map[string]any{
		"productTypeId": w.knx.ID, "categoryId": w.board.ID, "modelNumber": "A-1", "name": name("A-1"), "isActive": true,
		"attributes": map[string]any{"dimmers": 4, "width": 4, "bus": 10, "dimmer_led": 300}, "expectedUpdatedAt": a1.UpdatedAt}), http.StatusOK)
	if len(missing(fixed)) != 0 {
		t.Errorf("A-1 fixed missing %v", missing(fixed))
	}
	send[products.Product](t, api.Put("/api/products/"+a2.ID.String(), api.Admin.Cookie, map[string]any{
		"productTypeId": w.knx.ID, "categoryId": w.board.ID, "modelNumber": "A-2", "name": name("A-2"), "isActive": true,
		"attributes": map[string]any{"bus": 10, "width": 4, "dimmers": 2, "dimmer_led": 300}, "expectedUpdatedAt": a2.UpdatedAt}), http.StatusOK)
	r = get(t, api)
	for _, s := range r.Systems {
		if s.Key != "plain" && len(s.Items) != 0 {
			t.Errorf("%s not ready: %+v", s.Key, s.Items)
		}
	}
}

// Refs stop at 20; count says the rest.
func TestReadinessRefCap(t *testing.T) {
	api := apptest.New(t)
	w := setup(t, api)
	for i := range 23 {
		product(t, api, w.knx.ID, w.board.ID, "W-"+string(rune('A'+i)), map[string]any{"bus": 10}, true)
	}
	it := system(t, get(t, api), "knx")["product_board_without_width"]
	if it.Count != 23 || len(it.Refs) != readiness.MaxRefs || it.Refs[0].Kind != "product" || it.Refs[0].Label["en"] != "W-A" {
		t.Errorf("item %d refs %d %+v", it.Count, len(it.Refs), it.Refs[:1])
	}
}

func TestReadinessPermissions(t *testing.T) {
	api := apptest.New(t)
	if resp := api.Get("/api/catalog/readiness", ""); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: %d", resp.Code)
	}
	tenant := api.NewTenant("Installer")
	for _, role := range []auth.Role{auth.RoleUser} {
		u := api.NewUser(tenant, role)
		if resp := api.Get("/api/catalog/readiness", u.Cookie); resp.Code != http.StatusOK {
			t.Errorf("%s: %d %s", role, resp.Code, resp.Body)
		}
	}
}
