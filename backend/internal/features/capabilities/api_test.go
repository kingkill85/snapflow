package capabilities_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

type problem struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params"`
	Fields []struct {
		Location string         `json:"location"`
		Code     string         `json:"code"`
		Params   map[string]any `json:"params"`
	} `json:"fields"`
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func expect(t *testing.T, resp *httptest.ResponseRecorder, status int) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d: %s", resp.Code, status, resp.Body)
	}
}

func create[T any](t *testing.T, api *apptest.API, path string, body any) T {
	t.Helper()
	resp := api.Post(path, api.Admin.Cookie, body)
	expect(t, resp, http.StatusCreated)
	return decode[T](t, resp)
}

func assertError(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) problem {
	t.Helper()
	expect(t, resp, status)
	p := decode[problem](t, resp)
	if p.Code != code {
		t.Fatalf("code %q, want %q: %s", p.Code, code, resp.Body)
	}
	return p
}

// fieldCodes returns "location code" of each field error, sorted.
func fieldCodes(p problem) []string {
	out := []string{}
	for _, f := range p.Fields {
		out = append(out, f.Location+" "+f.Code)
	}
	sort.Strings(out)
	return out
}

func name(en string) map[string]string { return map[string]string{"en": en} }

func loadType(t *testing.T, api *apptest.API, key string) capabilities.LoadType {
	return create[capabilities.LoadType](t, api, "/api/load-types", map[string]any{"key": key, "name": name(key), "isActive": true})
}

func outputKind(t *testing.T, api *apptest.API, key string, body map[string]any) capabilities.OutputKind {
	if body == nil {
		body = map[string]any{}
	}
	body["key"], body["name"], body["isActive"] = key, name(key), true
	return create[capabilities.OutputKind](t, api, "/api/output-kinds", body)
}

func field(t *testing.T, api *apptest.API, body map[string]any) capabilities.CatalogField {
	if body["label"] == nil {
		body["label"] = name(body["key"].(string))
	}
	return create[capabilities.CatalogField](t, api, "/api/catalog-fields", body)
}

func TestLoadTypes(t *testing.T) {
	api := apptest.New(t)
	led := loadType(t, api, "led")
	halogen := loadType(t, api, "halogen")
	if led.SortOrder != 1 || halogen.SortOrder != 2 || !led.Can.Update {
		t.Errorf("created %+v %+v", led, halogen)
	}
	assertError(t, api.Post("/api/load-types", api.Admin.Cookie, map[string]any{"key": "led", "name": name("LED"), "isActive": true}),
		http.StatusConflict, "load_type.key_taken")
	p := assertError(t, api.Post("/api/load-types", api.Admin.Cookie, map[string]any{"key": "Bad Key", "name": map[string]string{"en": " "}, "isActive": true}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.key load_type.key_format", "body.name.en validation.required"}) {
		t.Errorf("fields %v", got)
	}
	// Optimistic update.
	upd := map[string]any{"key": "led", "name": name("LED lamps"), "isActive": false, "expectedUpdatedAt": led.UpdatedAt}
	expect(t, api.Put("/api/load-types/"+led.ID.String(), api.Admin.Cookie, upd), http.StatusOK)
	assertError(t, api.Put("/api/load-types/"+led.ID.String(), api.Admin.Cookie, upd), http.StatusConflict, "load_type.stale")
	// Inactive ones only on request; reorder.
	if list := decode[capabilities.LoadTypeList](t, api.Get("/api/load-types", api.Admin.Cookie)); len(list.Items) != 1 {
		t.Errorf("active list %+v", list.Items)
	}
	list := decode[capabilities.LoadTypeList](t, api.Put("/api/load-types/order", api.Admin.Cookie, map[string]any{"ids": []any{halogen.ID, led.ID}}))
	if len(list.Items) != 2 || list.Items[0].ID != halogen.ID {
		t.Errorf("reordered %+v", list.Items)
	}
	assertError(t, api.Put("/api/load-types/order", api.Admin.Cookie, map[string]any{"ids": []any{halogen.ID}}),
		http.StatusUnprocessableEntity, "load_type.order_mismatch")
	// A load type a function type allows cannot be deleted.
	create[functiontypes.FunctionType](t, api, "/api/function-types", map[string]any{"key": "dimmer", "name": name("Dimmer"),
		"allowsCircuit": true, "loadTypeIds": []any{led.ID}})
	assertError(t, api.Delete("/api/load-types/"+led.ID.String(), api.Admin.Cookie), http.StatusConflict, "load_type.in_use")
	expect(t, api.Delete("/api/load-types/"+halogen.ID.String(), api.Admin.Cookie), http.StatusNoContent)
	assertError(t, api.Delete("/api/load-types/"+halogen.ID.String(), api.Admin.Cookie), http.StatusNotFound, "load_type.not_found")
}

// Function types gain the circuit flag and their allowed load types.
func TestFunctionTypeExtension(t *testing.T) {
	api := apptest.New(t)
	led := loadType(t, api, "led")
	ft := create[functiontypes.FunctionType](t, api, "/api/function-types", map[string]any{"key": "dimmer", "name": name("Dimmer"),
		"allowsCircuit": true, "loadTypeIds": []any{led.ID}})
	if !ft.AllowsCircuit || len(ft.LoadTypeIDs) != 1 || ft.LoadTypeIDs[0] != led.ID {
		t.Errorf("created %+v", ft)
	}
	got := decode[functiontypes.FunctionType](t, api.Get("/api/function-types/"+ft.ID.String(), api.Admin.Cookie))
	if !got.AllowsCircuit || len(got.LoadTypeIDs) != 1 || got.LoadTypeIDs[0] != led.ID {
		t.Errorf("read %+v", got)
	}
	// Left out keeps the stored values (D294); false and [] clear them.
	upd := decode[functiontypes.FunctionType](t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie,
		map[string]any{"key": "dimmer", "name": name("Dimmer 2")}))
	if !upd.AllowsCircuit || len(upd.LoadTypeIDs) != 1 || upd.Name["en"] != "Dimmer 2" {
		t.Errorf("updated without flags %+v", upd)
	}
	upd = decode[functiontypes.FunctionType](t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie,
		map[string]any{"key": "dimmer", "name": name("Dimmer"), "allowsCircuit": false, "loadTypeIds": []any{}}))
	if upd.AllowsCircuit || len(upd.LoadTypeIDs) != 0 {
		t.Errorf("cleared %+v", upd)
	}
	p := assertError(t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie,
		map[string]any{"key": "dimmer", "name": name("Dimmer"), "loadTypeIds": []any{ft.ID}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.loadTypeIds load_type.not_found"}) {
		t.Errorf("fields %v", got)
	}
	// A function type an output kind serves cannot be deleted.
	outputKind(t, api, "dimmer_output", map[string]any{"functionTypeIds": []any{ft.ID}})
	assertError(t, api.Delete("/api/function-types/"+ft.ID.String(), api.Admin.Cookie), http.StatusConflict, "function_type.in_use")
}

func TestOutputKinds(t *testing.T) {
	api := apptest.New(t)
	sw := create[functiontypes.FunctionType](t, api, "/api/function-types", map[string]any{"key": "switching", "name": name("Switching")})
	relay := outputKind(t, api, "relay_output", map[string]any{"functionTypeIds": []any{sw.ID}})
	dimmer := outputKind(t, api, "dimmer_output", nil)
	blind := outputKind(t, api, "blind_output", map[string]any{"alternatives": []any{
		map[string]any{"outputKindId": relay.ID, "count": 2}, map[string]any{"outputKindId": dimmer.ID, "count": 2}}})
	if len(relay.FunctionTypeIDs) != 1 || relay.FunctionTypeIDs[0] != sw.ID || len(relay.Alternatives) != 0 {
		t.Errorf("relay %+v", relay)
	}
	if !reflect.DeepEqual(blind.Alternatives, []capabilities.OutputKindAlternative{{OutputKindID: relay.ID, Count: 2}, {OutputKindID: dimmer.ID, Count: 2}}) &&
		!reflect.DeepEqual(blind.Alternatives, []capabilities.OutputKindAlternative{{OutputKindID: dimmer.ID, Count: 2}, {OutputKindID: relay.ID, Count: 2}}) ||
		len(blind.FunctionTypeIDs) != 0 {
		t.Errorf("blind %+v", blind)
	}
	// No cycles of two, not itself, the count in range, known function types.
	upd := func(k capabilities.OutputKind, body map[string]any) *httptest.ResponseRecorder {
		body["key"], body["name"], body["isActive"], body["expectedUpdatedAt"] = k.Key, name(k.Key), true, k.UpdatedAt
		return api.Put("/api/output-kinds/"+k.ID.String(), api.Admin.Cookie, body)
	}
	alt := func(id uuid.UUID, n int) map[string]any { return map[string]any{"outputKindId": id, "count": n} }
	p := assertError(t, upd(relay, map[string]any{"alternatives": []any{alt(blind.ID, 1)}}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.alternatives[0].outputKindId output_kind.alternative_cycle"}) {
		t.Errorf("cycle %v", got)
	}
	p = assertError(t, upd(relay, map[string]any{"alternatives": []any{alt(dimmer.ID, 1), alt(relay.ID, 1)}}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.alternatives[1].outputKindId output_kind.alternative_self"}) {
		t.Errorf("self %v", got)
	}
	p = assertError(t, upd(relay, map[string]any{"alternatives": []any{alt(dimmer.ID, 1), alt(dimmer.ID, 2)}}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.alternatives[1].outputKindId output_kind.alternative_duplicate"}) {
		t.Errorf("duplicate alternative %v", got)
	}
	// Universal channels: each dimmer output may act as a relay output.
	universal := decode[capabilities.OutputKind](t, upd(relay, map[string]any{"functionTypeIds": []any{sw.ID}, "alternatives": []any{alt(dimmer.ID, 1)}}))
	relay = universal
	if len(universal.Alternatives) != 1 || universal.Alternatives[0].Count != 1 {
		t.Errorf("universal %+v", universal)
	}
	p = assertError(t, upd(relay, map[string]any{"functionTypeIds": []any{sw.ID, sw.ID}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.functionTypeIds[1] output_kind.function_type_duplicate"}) {
		t.Errorf("duplicate %v", got)
	}
	p = assertError(t, upd(relay, map[string]any{"functionTypeIds": []any{relay.ID}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.functionTypeIds function_type.not_found"}) {
		t.Errorf("unknown function type %v", got)
	}
	// A failed update changed nothing; a good one replaces the list.
	got := decode[capabilities.OutputKind](t, upd(relay, map[string]any{"functionTypeIds": []any{}}))
	if len(got.FunctionTypeIDs) != 0 {
		t.Errorf("updated %+v", got)
	}
	// The relay output is blind's alternative: in use.
	assertError(t, api.Delete("/api/output-kinds/"+relay.ID.String(), api.Admin.Cookie), http.StatusConflict, "output_kind.in_use")
	expect(t, api.Delete("/api/output-kinds/"+blind.ID.String(), api.Admin.Cookie), http.StatusNoContent)
	expect(t, api.Delete("/api/output-kinds/"+relay.ID.String(), api.Admin.Cookie), http.StatusNoContent)
	expect(t, api.Delete("/api/output-kinds/"+dimmer.ID.String(), api.Admin.Cookie), http.StatusNoContent)
}

func TestFieldValidation(t *testing.T) {
	api := apptest.New(t)
	relay := outputKind(t, api, "relay_output", nil)
	led := loadType(t, api, "led")
	post := func(body map[string]any) problem {
		t.Helper()
		if body["label"] == nil {
			body["label"] = name("Field")
		}
		return assertError(t, api.Post("/api/catalog-fields", api.Admin.Cookie, body), http.StatusUnprocessableEntity, "validation.failed")
	}
	cases := []struct {
		body map[string]any
		want []string
	}{
		{map[string]any{"key": "w", "type": "number", "meaning": "channel_limit_w"},
			[]string{"body.loadTypeId validation.required", "body.outputKindId validation.required"}},
		{map[string]any{"key": "w", "type": "text", "meaning": "channels_supplied", "outputKindId": relay.ID},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "w", "type": "number", "outputKindId": relay.ID, "productTypeIds": []any{relay.ID}},
			[]string{"body.outputKindId catalog_field.param_not_allowed", "body.productTypeIds catalog_field.param_not_allowed"}},
		{map[string]any{"key": "w", "type": "number", "meaning": "bus_current_used_ma", "loadTypeId": led.ID},
			[]string{"body.loadTypeId catalog_field.param_not_allowed"}},
		{map[string]any{"key": "w", "type": "integer", "meaning": "channels_supplied", "outputKindId": led.ID},
			[]string{"body.outputKindId output_kind.not_found"}},
		{map[string]any{"key": "w", "type": "enum", "meaning": "motor_type",
			"options": []any{map[string]any{"key": "ac", "label": name("AC")}, map[string]any{"key": "three_phase", "label": name("3~")}}},
			[]string{"body.options catalog_field.meaning_options"}},
		{map[string]any{"key": "w", "type": "text", "meaning": "motor_type"},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "w", "type": "number", "meaning": "channels_supplied", "outputKindId": relay.ID},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "w", "type": "number", "meaning": "enclosure_rows"},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "w", "type": "number", "meaning": "wireless_place_used"},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "w", "type": "number", "meaning": "alternative_allowed", "outputKindId": relay.ID},
			[]string{"body.type catalog_field.meaning_type"}},
		{map[string]any{"key": "Bad", "type": "boolean", "meaning": "zigbee_router", "unit": "much too long a unit"},
			[]string{"body.key catalog_field.key_format", "body.unit validation.too_long"}},
	}
	for i, c := range cases {
		if got := fieldCodes(post(c.body)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("case %d: %v, want %v", i, got, c.want)
		}
	}
	// An unknown product type comes from the foreign key.
	p := post(map[string]any{"key": "places", "type": "integer", "meaning": "wireless_place_used", "productTypeIds": []any{relay.ID}})
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.productTypeIds product_type.not_found"}) {
		t.Errorf("product type: %v", got)
	}
	ok := field(t, api, map[string]any{"key": "led_w", "type": "number", "unit": " W ", "meaning": "channel_limit_w",
		"outputKindId": relay.ID, "loadTypeId": led.ID, "etimFeature": "ef000008"})
	if ok.Unit != "W" || ok.EtimFeature != "EF000008" || *ok.OutputKindID != relay.ID || *ok.LoadTypeID != led.ID {
		t.Errorf("created %+v", ok)
	}
	p = assertError(t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "led_w", "label": name("x"), "type": "text"}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.key catalog_field.key_taken"}) {
		t.Errorf("taken %v", got)
	}
	// Output kinds and load types a field names are in use.
	assertError(t, api.Delete("/api/output-kinds/"+relay.ID.String(), api.Admin.Cookie), http.StatusConflict, "output_kind.in_use")
	assertError(t, api.Delete("/api/load-types/"+led.ID.String(), api.Admin.Cookie), http.StatusConflict, "load_type.in_use")
	meanings := decode[capabilities.MeaningList](t, api.Get("/api/catalog-field-meanings", api.Admin.Cookie))
	if len(meanings.Items) != 17 || meanings.Items[1].Meaning != capabilities.MeaningChannelLimitW || !meanings.Items[1].LoadTypeRequired ||
		!meanings.Items[2].LoadType || meanings.Items[2].LoadTypeRequired {
		t.Errorf("meanings %+v", meanings.Items)
	}
	// Optional load types: channel_limit_a with and without one.
	field(t, api, map[string]any{"key": "a_any", "type": "number", "meaning": "channel_limit_a", "outputKindId": relay.ID})
	field(t, api, map[string]any{"key": "a_led", "type": "number", "meaning": "channel_limit_a", "outputKindId": relay.ID, "loadTypeId": led.ID})
	field(t, api, map[string]any{"key": "total_led", "type": "number", "meaning": "module_total_w", "loadTypeId": led.ID})
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Partner"), auth.RoleUser)
	for _, path := range []string{"/api/load-types", "/api/output-kinds", "/api/catalog-fields", "/api/catalog-field-meanings"} {
		if resp := api.Get(path); resp.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s: %d", path, resp.Code)
		}
		if resp := api.Get(path, user.Cookie); resp.Code != http.StatusOK {
			t.Errorf("user read %s: %d", path, resp.Code)
		}
	}
	for path, body := range map[string]map[string]any{
		"/api/load-types":     {"key": "x", "name": name("x"), "isActive": true},
		"/api/output-kinds":   {"key": "x", "name": name("x"), "isActive": true},
		"/api/catalog-fields": {"key": "x", "label": name("x"), "type": "text"},
	} {
		assertError(t, api.Post(path, user.Cookie, body), http.StatusForbidden, "auth.forbidden")
	}
}

// productTypeSettings: the reserve defaults to 20, the others are optional
// and range checked.
func TestProductTypeSettings(t *testing.T) {
	api := apptest.New(t)
	pt := create[producttypes.ProductType](t, api, "/api/product-types", map[string]any{"key": "knx", "name": name("KNX"), "isActive": true})
	if pt.ReservePercent != 20 || pt.DefaultBusCurrentMa != nil || pt.BusDevicesMax != nil {
		t.Errorf("defaults %+v", pt)
	}
	resp := api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{"key": "knx", "name": name("KNX"), "isActive": true,
		"defaultBusCurrentMa": 10, "reservePercent": 25, "busDevicesMax": 64, "expectedUpdatedAt": pt.UpdatedAt})
	got := decode[producttypes.ProductType](t, resp)
	if got.ReservePercent != 25 || *got.DefaultBusCurrentMa != 10 || *got.BusDevicesMax != 64 {
		t.Errorf("updated %+v", got)
	}
	// Left out keeps the stored settings (D294); 0 clears the optional ones.
	got = decode[producttypes.ProductType](t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "knx", "name": name("KNX 2"), "isActive": true, "expectedUpdatedAt": got.UpdatedAt}))
	if got.ReservePercent != 25 || got.DefaultBusCurrentMa == nil || *got.DefaultBusCurrentMa != 10 || got.BusDevicesMax == nil || *got.BusDevicesMax != 64 {
		t.Errorf("kept %+v", got)
	}
	got = decode[producttypes.ProductType](t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "knx", "name": name("KNX"), "isActive": true, "defaultBusCurrentMa": 0, "busDevicesMax": 0, "expectedUpdatedAt": got.UpdatedAt}))
	if got.ReservePercent != 25 || got.DefaultBusCurrentMa != nil || got.BusDevicesMax != nil {
		t.Errorf("cleared %+v", got)
	}
	p := assertError(t, api.Post("/api/product-types", api.Admin.Cookie, map[string]any{"key": "hdl", "name": name("HDL"), "isActive": true,
		"reservePercent": 95, "defaultBusCurrentMa": -1}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.defaultBusCurrentMa validation.range", "body.reservePercent validation.range"}) {
		t.Errorf("fields %v", got)
	}
	// Topology (D304): default none, kept when left out.
	if pt.Topology != "none" {
		t.Errorf("topology %q", pt.Topology)
	}
	got = decode[producttypes.ProductType](t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "knx", "name": name("KNX"), "isActive": true, "topology": "wireless", "defaultWirelessPlacesUsed": 2, "expectedUpdatedAt": got.UpdatedAt}))
	if got.Topology != "wireless" || got.DefaultWirelessPlacesUsed == nil || *got.DefaultWirelessPlacesUsed != 2 {
		t.Errorf("topology %+v", got)
	}
	got = decode[producttypes.ProductType](t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "knx", "name": name("KNX"), "isActive": true, "expectedUpdatedAt": got.UpdatedAt}))
	if got.Topology != "wireless" || got.DefaultWirelessPlacesUsed == nil {
		t.Errorf("topology kept %+v", got)
	}
	p = assertError(t, api.Put("/api/product-types/"+pt.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "knx", "name": name("KNX"), "isActive": true, "defaultWirelessPlacesUsed": 5000, "expectedUpdatedAt": got.UpdatedAt}),
		http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.defaultWirelessPlacesUsed validation.range"}) {
		t.Errorf("topology fields %v", got)
	}
}

type capabilityWorld struct {
	knx, zigbee          producttypes.ProductType
	relay, blind, dimmer capabilities.OutputKind
	led                  capabilities.LoadType
	category             categories.Category
}

func setupWorld(t *testing.T, api *apptest.API) capabilityWorld {
	var w capabilityWorld
	w.knx = create[producttypes.ProductType](t, api, "/api/product-types", map[string]any{"key": "knx", "name": name("KNX"), "isActive": true,
		"topology": "bus", "defaultBusCurrentMa": 10})
	w.zigbee = create[producttypes.ProductType](t, api, "/api/product-types", map[string]any{"key": "zigbee", "name": name("Zigbee"), "isActive": true,
		"topology": "wireless", "defaultWirelessPlacesUsed": 1})
	w.relay = outputKind(t, api, "relay_output", nil)
	w.dimmer = outputKind(t, api, "dimmer_output", nil)
	w.blind = outputKind(t, api, "blind_output", map[string]any{"alternatives": []any{map[string]any{"outputKindId": w.relay.ID, "count": 2}}})
	w.led = loadType(t, api, "led")
	field(t, api, map[string]any{"key": "relay_outputs", "type": "integer", "meaning": "channels_supplied", "outputKindId": w.relay.ID})
	field(t, api, map[string]any{"key": "dimmer_outputs", "type": "integer", "meaning": "channels_supplied", "outputKindId": w.dimmer.ID})
	field(t, api, map[string]any{"key": "dimmer_led_w", "type": "number", "unit": "W", "meaning": "channel_limit_w",
		"outputKindId": w.dimmer.ID, "loadTypeId": w.led.ID})
	field(t, api, map[string]any{"key": "bus_current_ma", "type": "number", "unit": "mA", "meaning": "bus_current_used_ma"})
	field(t, api, map[string]any{"key": "width_te", "type": "number", "unit": "TE", "meaning": "rail_width_te"})
	field(t, api, map[string]any{"key": "zigbee_place", "type": "integer", "meaning": "wireless_place_used", "productTypeIds": []any{w.zigbee.ID}})
	field(t, api, map[string]any{"key": "router", "type": "boolean", "meaning": "zigbee_router"})
	field(t, api, map[string]any{"key": "motor", "type": "enum", "meaning": "motor_type",
		"options": []any{map[string]any{"key": "ac", "label": name("AC")}, map[string]any{"key": "dc", "label": name("DC")}}})
	field(t, api, map[string]any{"key": "notes", "type": "text"})
	field(t, api, map[string]any{"key": "relays_as_blinds", "type": "boolean", "meaning": "alternative_allowed", "outputKindId": w.blind.ID})
	field(t, api, map[string]any{"key": "relay_min_w", "type": "number", "meaning": "channel_min_load_w", "outputKindId": w.relay.ID})
	field(t, api, map[string]any{"key": "module_w", "type": "number", "meaning": "module_total_w"})
	field(t, api, map[string]any{"key": "module_led_w", "type": "number", "meaning": "module_total_w", "loadTypeId": w.led.ID})
	attr := func(key, typ, fieldKey string, extra map[string]any) map[string]any {
		a := map[string]any{"key": key, "label": name(key), "type": typ, "fieldKey": fieldKey}
		for k, v := range extra {
			a[k] = v
		}
		return a
	}
	w.category = create[categories.Category](t, api, "/api/categories", map[string]any{"key": "actuators", "name": name("Actuators"),
		"isActive": true, "mounting": "board", "instanceAttributes": []any{},
		"attributes": []any{
			attr("relays", "integer", "relay_outputs", nil),
			attr("dimmers", "integer", "dimmer_outputs", nil),
			attr("dimmer_led", "number", "dimmer_led_w", map[string]any{"unit": "kW"}),
			attr("bus_ma", "number", "bus_current_ma", nil),
			attr("width", "number", "width_te", nil),
			attr("place", "integer", "zigbee_place", nil),
			attr("router", "boolean", "router", nil),
			attr("motor", "enum", "motor", map[string]any{"scope": "variant", "options": []any{map[string]any{"key": "x", "label": name("X")}}}),
			attr("notes", "text", "notes", nil),
			attr("plain", "integer", "", nil),
			attr("as_blinds", "boolean", "relays_as_blinds", nil),
			attr("relay_min", "number", "relay_min_w", nil),
			attr("module_w", "number", "module_w", nil),
			attr("module_led", "number", "module_led_w", nil),
		}})
	return w
}

// Category attributes linked to a catalog field take its unit and options
// and must have its type; a linked field keeps its key and type.
func TestCategoryFieldLinks(t *testing.T) {
	api := apptest.New(t)
	w := setupWorld(t, api)
	if w.category.Mounting != "board" {
		t.Errorf("mounting %q", w.category.Mounting)
	}
	a := w.category.Attributes
	if a[2].Unit != "W" || a[2].FieldKey != "dimmer_led_w" || len(a[7].Options) != 2 || a[7].Options[0].Key != "ac" {
		t.Errorf("linked attributes %+v", a)
	}
	p := assertError(t, api.Post("/api/categories", api.Admin.Cookie, map[string]any{"key": "bad", "name": name("Bad"), "isActive": true,
		"instanceAttributes": []any{},
		"attributes": []any{
			map[string]any{"key": "a", "label": name("A"), "type": "text", "fieldKey": "relay_outputs"},
			map[string]any{"key": "b", "label": name("B"), "type": "text", "fieldKey": "nope"},
		}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.attributes[0].type attribute.field_type",
		"body.attributes[1].fieldKey attribute.field_not_found"}) {
		t.Errorf("fields %v", got)
	}
	// Left out on update keeps the stored mounting (D294).
	kept := decode[categories.Category](t, api.Put("/api/categories/"+w.category.ID.String(), api.Admin.Cookie, map[string]any{
		"key": "actuators", "name": name("Actuators 2"), "isActive": true, "attributes": w.category.Attributes,
		"instanceAttributes": []any{}, "expectedUpdatedAt": w.category.UpdatedAt}))
	if kept.Mounting != "board" || kept.Name["en"] != "Actuators 2" {
		t.Errorf("kept mounting %q %v", kept.Mounting, kept.Name)
	}
	// Default mounting.
	c := create[categories.Category](t, api, "/api/categories", map[string]any{"key": "plain", "name": name("Plain"), "isActive": true,
		"attributes": []any{}, "instanceAttributes": []any{}})
	if c.Mounting != "floorplan" {
		t.Errorf("default mounting %q", c.Mounting)
	}
	// A linked field keeps key and type, and cannot be deleted.
	fields := decode[capabilities.CatalogFieldList](t, api.Get("/api/catalog-fields", api.Admin.Cookie))
	var relays capabilities.CatalogField
	for _, f := range fields.Items {
		if f.Key == "relay_outputs" {
			relays = f
		}
	}
	upd := map[string]any{"key": "relay_outputs", "label": name("Relays"), "type": "number", "meaning": "channels_supplied",
		"outputKindId": w.relay.ID, "expectedUpdatedAt": relays.UpdatedAt}
	assertError(t, api.Put("/api/catalog-fields/"+relays.ID.String(), api.Admin.Cookie, upd), http.StatusConflict, "catalog_field.in_use")
	upd["type"] = "integer"
	got := decode[capabilities.CatalogField](t, api.Put("/api/catalog-fields/"+relays.ID.String(), api.Admin.Cookie, upd))
	if got.Label["en"] != "Relays" {
		t.Errorf("label %+v", got.Label)
	}
	assertError(t, api.Delete("/api/catalog-fields/"+relays.ID.String(), api.Admin.Cookie), http.StatusConflict, "catalog_field.in_use")
	upd["expectedUpdatedAt"] = time.Time{}
	assertError(t, api.Put("/api/catalog-fields/"+relays.ID.String(), api.Admin.Cookie, upd), http.StatusConflict, "catalog_field.stale")
}

func newProduct(t *testing.T, api *apptest.API, w capabilityWorld, typeID any, model string, attrs map[string]any, mounting string) products.Product {
	body := map[string]any{"productTypeId": typeID, "categoryId": w.category.ID, "modelNumber": model, "name": name(model),
		"isActive": true, "attributes": attrs}
	if mounting != "" {
		body["mounting"] = mounting
	}
	return create[products.Product](t, api, "/api/products", body)
}

func TestCapabilities(t *testing.T) {
	api := apptest.New(t)
	w := setupWorld(t, api)
	p := newProduct(t, api, w, w.knx.ID, "KNX-1", map[string]any{"relays": 8, "dimmers": 2, "dimmer_led": 200, "width": 4.5,
		"place": 1, "router": true, "notes": "x", "plain": 3, "bus_ma": nil, "as_blinds": true, "relay_min": 5,
		"module_w": 3000, "module_led": 1200}, "")
	c := p.Capabilities
	if c.Mounting != "board" || len(c.Channels) != 2 {
		t.Fatalf("capabilities %+v", c)
	}
	// In output kind order: relay, dimmer.
	relay, dimmer := c.Channels[0], c.Channels[1]
	if relay.OutputKindKey != "relay_output" || relay.Count != 8 || len(relay.LimitsW) != 0 ||
		!reflect.DeepEqual(relay.Alternatives, []capabilities.ChannelAlternative{{OutputKindID: w.blind.ID, OutputKindKey: "blind_output", Per: 2, Max: 4}}) ||
		len(relay.MinLoadsW) != 1 || relay.MinLoadsW[0].LoadTypeID != nil || relay.MinLoadsW[0].Value != 5 {
		t.Errorf("relay %+v", relay)
	}
	if dimmer.Count != 2 || len(dimmer.LimitsW) != 1 || dimmer.LimitsW[0].LoadTypeKey != "led" || dimmer.LimitsW[0].Value != 200 ||
		len(dimmer.Alternatives) != 0 {
		t.Errorf("dimmer %+v", dimmer)
	}
	if len(c.ModuleTotalsW) != 2 || c.ModuleTotalsW[0].LoadTypeID != nil || c.ModuleTotalsW[0].Value != 3000 ||
		c.ModuleTotalsW[1].LoadTypeKey != "led" || c.ModuleTotalsW[1].Value != 1200 {
		t.Errorf("module totals %+v", c.ModuleTotalsW)
	}
	// Empty values do not count (the bus current falls back to the KNX
	// default, marked as such); a meaning limited to Zigbee does not apply
	// to KNX.
	if c.BusCurrentUsedMa == nil || *c.BusCurrentUsedMa != 10 || !c.BusCurrentUsedMaDefault || c.WirelessPlacesUsed != nil ||
		c.RailWidthTE == nil || *c.RailWidthTE != 4.5 || c.ZigbeeRouter == nil || !*c.ZigbeeRouter || c.MotorType != "" {
		t.Errorf("capabilities %+v", c)
	}
	// Without the opt-in no alternatives (D303).
	plain := newProduct(t, api, w, w.knx.ID, "KNX-2", map[string]any{"relays": 8, "as_blinds": false, "bus_ma": 20}, "")
	if len(plain.Capabilities.Channels) != 1 || len(plain.Capabilities.Channels[0].Alternatives) != 0 ||
		*plain.Capabilities.BusCurrentUsedMa != 20 || plain.Capabilities.BusCurrentUsedMaDefault {
		t.Errorf("no opt-in %+v", plain.Capabilities)
	}
	// The product's mounting override wins; Zigbee products use a place.
	z := newProduct(t, api, w, w.zigbee.ID, "ZB-1", map[string]any{"place": 3, "bus_ma": 12}, "floorplan")
	if z.Mounting != "floorplan" || z.Capabilities.Mounting != "floorplan" || z.Capabilities.WirelessPlacesUsed == nil ||
		*z.Capabilities.WirelessPlacesUsed != 3 || z.Capabilities.WirelessPlacesUsedDefault || *z.Capabilities.BusCurrentUsedMa != 12 ||
		z.Capabilities.BusCurrentUsedMaDefault || len(z.Capabilities.Channels) != 0 {
		t.Errorf("zigbee %+v", z.Capabilities)
	}
	// A Zigbee product without a value uses the product type's default place.
	z2 := newProduct(t, api, w, w.zigbee.ID, "ZB-2", map[string]any{}, "")
	if z2.Capabilities.WirelessPlacesUsed == nil || *z2.Capabilities.WirelessPlacesUsed != 1 || !z2.Capabilities.WirelessPlacesUsedDefault ||
		z2.Capabilities.BusCurrentUsedMa != nil {
		t.Errorf("zigbee default %+v", z2.Capabilities)
	}
	assertError(t, api.Post("/api/products", api.Admin.Cookie, map[string]any{"productTypeId": w.knx.ID, "categoryId": w.category.ID,
		"modelNumber": "X", "name": name("X"), "mounting": "roof"}), http.StatusUnprocessableEntity, "validation.failed")
	// Left out on update keeps the override (D294); empty clears it.
	zb := map[string]any{"productTypeId": w.zigbee.ID, "categoryId": w.category.ID, "modelNumber": "ZB-1", "name": name("ZB 1"),
		"isActive": true, "attributes": map[string]any{"place": 1, "bus_ma": 12}, "expectedUpdatedAt": z.UpdatedAt}
	z = decode[products.Product](t, api.Put("/api/products/"+z.ID.String(), api.Admin.Cookie, zb))
	if z.Mounting != "floorplan" || z.Name["en"] != "ZB 1" {
		t.Errorf("kept override %q", z.Mounting)
	}
	zb["mounting"], zb["expectedUpdatedAt"] = "", z.UpdatedAt
	z = decode[products.Product](t, api.Put("/api/products/"+z.ID.String(), api.Admin.Cookie, zb))
	if z.Mounting != "" || z.Capabilities.Mounting != "board" {
		t.Errorf("cleared override %q %q", z.Mounting, z.Capabilities.Mounting)
	}
	// A variant adds its own values (motor type is per variant).
	resp := api.Post("/api/products/"+p.ID.String()+"/variants", api.Admin.Cookie, map[string]any{"name": name("AC"), "price": "10",
		"isActive": true, "attributes": map[string]any{"motor": "ac"}})
	expect(t, resp, http.StatusCreated)
	v := decode[products.Variant](t, resp)
	if v.Capabilities.MotorType != "ac" || len(v.Capabilities.Channels) != 2 || v.Capabilities.Mounting != "board" {
		t.Errorf("variant %+v", v.Capabilities)
	}
	got := decode[products.Product](t, api.Get("/api/products/"+p.ID.String(), api.Admin.Cookie))
	if got.Capabilities.MotorType != "" || got.Variants[0].Capabilities.MotorType != "ac" {
		t.Errorf("product %+v / variant %+v", got.Capabilities, got.Variants[0].Capabilities)
	}
	// Meanings apply live: making the relay field "just information" drops
	// the relay channels.
	fields := decode[capabilities.CatalogFieldList](t, api.Get("/api/catalog-fields", api.Admin.Cookie))
	for _, f := range fields.Items {
		if f.Key == "relay_outputs" {
			expect(t, api.Put("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie, map[string]any{"key": f.Key, "label": f.Label,
				"type": "integer", "expectedUpdatedAt": f.UpdatedAt}), http.StatusOK)
		}
	}
	got = decode[products.Product](t, api.Get("/api/products/"+p.ID.String(), api.Admin.Cookie))
	if len(got.Capabilities.Channels) != 1 || got.Capabilities.Channels[0].OutputKindKey != "dimmer_output" {
		t.Errorf("after information %+v", got.Capabilities.Channels)
	}
}

// Inactive output kinds are left out of the computation: their channels and
// the alternatives to them (D311).
func TestCapabilitiesInactiveKinds(t *testing.T) {
	api := apptest.New(t)
	w := setupWorld(t, api)
	p := newProduct(t, api, w, w.knx.ID, "KNX-1", map[string]any{"relays": 4, "dimmers": 2, "as_blinds": true}, "")
	if len(p.Capabilities.Channels) != 2 || len(p.Capabilities.Channels[0].Alternatives) != 1 {
		t.Fatalf("active %+v", p.Capabilities.Channels)
	}
	deactivate := func(k capabilities.OutputKind) {
		k = decode[capabilities.OutputKind](t, api.Get("/api/output-kinds/"+k.ID.String(), api.Admin.Cookie))
		expect(t, api.Put("/api/output-kinds/"+k.ID.String(), api.Admin.Cookie, map[string]any{"key": k.Key, "name": k.Name,
			"isActive": false, "alternatives": k.Alternatives, "expectedUpdatedAt": k.UpdatedAt}), http.StatusOK)
	}
	deactivate(w.blind)
	got := decode[products.Product](t, api.Get("/api/products/"+p.ID.String(), api.Admin.Cookie))
	if len(got.Capabilities.Channels) != 2 || len(got.Capabilities.Channels[0].Alternatives) != 0 {
		t.Errorf("blind inactive %+v", got.Capabilities.Channels)
	}
	deactivate(w.relay)
	got = decode[products.Product](t, api.Get("/api/products/"+p.ID.String(), api.Admin.Cookie))
	if len(got.Capabilities.Channels) != 1 || got.Capabilities.Channels[0].OutputKindKey != "dimmer_output" {
		t.Errorf("relay inactive %+v", got.Capabilities.Channels)
	}
}

// Linked attributes are resolved from the field when read (D308): a unit or
// option change shows at once.
func TestCategoryReadsFieldChanges(t *testing.T) {
	api := apptest.New(t)
	w := setupWorld(t, api)
	fields := decode[capabilities.CatalogFieldList](t, api.Get("/api/catalog-fields", api.Admin.Cookie))
	for _, f := range fields.Items {
		switch f.Key {
		case "width_te":
			if f.InUse != 1 || len(f.UsedBy) != 1 || f.UsedBy[0].Key != "actuators" {
				t.Errorf("in use %+v", f)
			}
			expect(t, api.Put("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie, map[string]any{"key": f.Key, "label": f.Label,
				"type": "number", "unit": "mm", "meaning": "rail_width_te", "expectedUpdatedAt": f.UpdatedAt}), http.StatusOK)
		case "notes":
			if f.InUse != 1 {
				t.Errorf("notes in use %+v", f)
			}
		}
	}
	c := decode[categories.Category](t, api.Get("/api/categories/"+w.category.ID.String(), api.Admin.Cookie))
	if c.Attributes[4].Key != "width" || c.Attributes[4].Unit != "mm" {
		t.Errorf("width %+v", c.Attributes[4])
	}
}

// A category save and a field type change cannot both win (D305): whichever
// commits first, the other sees it.
func TestFieldLinkRace(t *testing.T) {
	api := apptest.New(t)
	for i := range 8 {
		key := fmt.Sprintf("race_%d", i)
		f := field(t, api, map[string]any{"key": key, "type": "integer"})
		body := map[string]any{"key": key, "name": name(key), "isActive": true, "instanceAttributes": []any{},
			"attributes": []any{map[string]any{"key": "n", "label": name("N"), "type": "integer", "fieldKey": key}}}
		var wg sync.WaitGroup
		var catCode, fieldCode int
		wg.Add(2)
		go func() {
			defer wg.Done()
			catCode = api.Post("/api/categories", api.Admin.Cookie, body).Code
		}()
		go func() {
			defer wg.Done()
			fieldCode = api.Put("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie, map[string]any{"key": key, "label": name(key),
				"type": "text", "expectedUpdatedAt": f.UpdatedAt}).Code
		}()
		wg.Wait()
		// Exactly one wins.
		switch {
		case catCode == http.StatusCreated && fieldCode == http.StatusConflict:
		case catCode == http.StatusUnprocessableEntity && fieldCode == http.StatusOK:
		default:
			t.Errorf("round %d: category %d, field %d", i, catCode, fieldCode)
		}
	}
	// Delete against a link: the foreign key.
	f := field(t, api, map[string]any{"key": "linked", "type": "integer"})
	create[categories.Category](t, api, "/api/categories", map[string]any{"key": "linked", "name": name("L"), "isActive": true,
		"instanceAttributes": []any{}, "attributes": []any{map[string]any{"key": "n", "label": name("N"), "type": "integer", "fieldKey": "linked"}}})
	assertError(t, api.Delete("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie), http.StatusConflict, "catalog_field.in_use")
}

// Compute directly: the first attribute of a meaning wins, blank values do
// not count; wireless_place_used yes/no is 1/0 (D312).
func TestCompute(t *testing.T) {
	kind := capabilities.OutputKind{Key: "relay"}
	kind.ID[0] = 1
	reg := capabilities.Registry{
		Fields: map[string]capabilities.CatalogField{
			"a": {Key: "a", Meaning: capabilities.MeaningChannelsSupplied, OutputKindID: &kind.ID},
			"w": {Key: "w", Meaning: capabilities.MeaningWirelessPlaceUsed},
		},
		OutputKinds: []capabilities.OutputKind{kind},
	}
	in := capabilities.Input{Mounting: "both", Values: map[string]any{"x": 3.0, "y": 5.0, "w": false}}
	in.Schema = append(in.Schema, categoriesAttr("x", "a"), categoriesAttr("y", "a"), categoriesAttr("w", "w"))
	c := capabilities.Compute(reg, in)
	if len(c.Channels) != 1 || c.Channels[0].Count != 3 || c.WirelessPlacesUsed == nil || *c.WirelessPlacesUsed != 0 || c.Mounting != "both" {
		t.Errorf("compute %+v", c)
	}
	in.Values = map[string]any{"y": 0.0, "w": true}
	c = capabilities.Compute(reg, in)
	if len(c.Channels) != 0 || c.WirelessPlacesUsed == nil || *c.WirelessPlacesUsed != 1 {
		t.Errorf("compute %+v", c)
	}
	in.Values = map[string]any{}
	if c = capabilities.Compute(reg, in); c.WirelessPlacesUsed != nil {
		t.Errorf("missing %+v", c)
	}
	// A meaning limited to another product type does not count.
	other := uuid.New()
	f := reg.Fields["a"]
	f.ProductTypeIDs = []uuid.UUID{other}
	reg.Fields["a"] = f
	in.Values = map[string]any{"x": 3.0}
	if c = capabilities.Compute(reg, in); len(c.Channels) != 0 {
		t.Errorf("limited %+v", c)
	}
	in.ProductTypeID = other
	if c = capabilities.Compute(reg, in); len(c.Channels) != 1 {
		t.Errorf("limited to this type %+v", c)
	}
}

func categoriesAttr(key, fieldKey string) attrschema.AttributeDefinition {
	return attrschema.AttributeDefinition{Definition: attrschema.Definition{Key: key, Type: attrschema.TypeNumber, FieldKey: fieldKey}}
}
