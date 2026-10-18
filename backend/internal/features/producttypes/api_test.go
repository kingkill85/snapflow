package producttypes_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

type productType struct {
	ID                 string           `json:"id"`
	Key                string           `json:"key"`
	Name               map[string]any   `json:"name"`
	Description        map[string]any   `json:"description"`
	Color              string           `json:"color"`
	SortOrder          int              `json:"sortOrder"`
	IsActive           bool             `json:"isActive"`
	Attributes         []map[string]any `json:"attributes"`
	InstanceAttributes []map[string]any `json:"instanceAttributes"`
	Can                auth.Actions     `json:"can"`
	UpdatedAt          string           `json:"updatedAt"`
}

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

func body(key string) map[string]any {
	return map[string]any{
		"key":                key,
		"name":               map[string]string{"en": "Dimmer actuator", "de": "Dimmaktor"},
		"isActive":           true,
		"attributes":         []any{},
		"instanceAttributes": []any{},
	}
}

// updateBody is b as an update of pt (expectedUpdatedAt from pt).
func updateBody(pt productType, b map[string]any) map[string]any {
	b["expectedUpdatedAt"] = pt.UpdatedAt
	return b
}

func create(t *testing.T, api *apptest.API, b map[string]any) productType {
	t.Helper()
	resp := api.Post("/api/product-types", api.Admin.Cookie, b)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create %v: got %d: %s", b["key"], resp.Code, resp.Body)
	}
	return decode[productType](t, resp)
}

func list(t *testing.T, api *apptest.API, cookie, query string) []productType {
	t.Helper()
	resp := api.Get("/api/product-types"+query, cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("list: got %d: %s", resp.Code, resp.Body)
	}
	return decode[struct{ Items []productType }](t, resp).Items
}

func keys(items []productType) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Key)
	}
	return out
}

func TestCRUD(t *testing.T) {
	api := apptest.New(t)

	b := body("dimmer_actuator")
	b["description"] = map[string]string{"en": " DIN rail dimmer ", "de": ""}
	b["attributes"] = []any{
		map[string]any{"key": "width_te", "label": map[string]string{"en": "Width"}, "type": "integer",
			"required": true, "unit": "TE", "min": 1, "max": 24},
		map[string]any{"key": "bus_system", "label": map[string]string{"en": "Bus system"}, "type": "enum",
			"options": []any{map[string]any{"key": "zigbee", "label": map[string]string{"en": "Zigbee"}}}},
		map[string]any{"key": "colour", "label": map[string]string{"en": "Colour"}, "type": "text", "scope": "variant"},
	}
	b["instanceAttributes"] = []any{
		map[string]any{"key": "address", "label": map[string]string{"en": "Address"}, "type": "integer"},
	}
	created := create(t, api, b)
	if created.SortOrder != 1 || !created.IsActive || !created.Can.Update || !created.Can.Delete {
		t.Errorf("created: %+v", created)
	}
	if !reflect.DeepEqual(created.Description, map[string]any{"en": "DIN rail dimmer"}) {
		t.Errorf("description not normalised: %v", created.Description)
	}
	if len(created.Attributes) != 3 || created.Attributes[0]["scope"] != "product" || created.Attributes[2]["scope"] != "variant" {
		t.Errorf("attributes: %v", created.Attributes)
	}
	if _, ok := created.InstanceAttributes[0]["scope"]; ok {
		t.Errorf("instance attribute has a scope: %v", created.InstanceAttributes[0])
	}

	resp := api.Get("/api/product-types/"+created.ID, api.Admin.Cookie)
	got := decode[productType](t, resp)
	if resp.Code != http.StatusOK || !reflect.DeepEqual(got, created) {
		t.Fatalf("get: got %d: %+v", resp.Code, got)
	}

	second := create(t, api, body("wall_switch"))
	if second.SortOrder != 2 {
		t.Errorf("second type got sort order %d, want 2", second.SortOrder)
	}

	upd := updateBody(created, body("dimmer"))
	upd["isActive"] = false
	resp = api.Put("/api/product-types/"+created.ID, api.Admin.Cookie, upd)
	if resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	updated := decode[productType](t, resp)
	if updated.Key != "dimmer" || updated.IsActive || updated.SortOrder != 1 || len(updated.Attributes) != 0 || updated.Description != nil {
		t.Errorf("updated: %+v", updated)
	}

	if resp := api.Delete("/api/product-types/"+created.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d: %s", resp.Code, resp.Body)
	}
	if got := keys(list(t, api, api.Admin.Cookie, "?includeInactive=true")); !reflect.DeepEqual(got, []string{"wall_switch"}) {
		t.Errorf("after delete: %v", got)
	}
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	pt := create(t, api, body("gateway"))
	partner := api.NewTenant("Partner")
	user := api.NewUser(partner, auth.RoleUser)
	tenantAdmin := api.NewUser(partner, auth.RoleTenantAdmin)
	path := "/api/product-types/" + pt.ID

	if resp := api.Get("/api/product-types"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous list: got %d", resp.Code)
	}
	if resp := api.Get(path); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous get: got %d", resp.Code)
	}
	for name, s := range map[string]apptest.Session{"user": user, "tenant admin": tenantAdmin} {
		items := list(t, api, s.Cookie, "")
		if len(items) != 1 || items[0].Can.Update || items[0].Can.Delete {
			t.Errorf("%s list: %+v", name, items)
		}
		if resp := api.Get(path, s.Cookie); resp.Code != http.StatusOK {
			t.Errorf("%s get: got %d", name, resp.Code)
		}
		writes := map[string]*httptest.ResponseRecorder{
			"create":  api.Post("/api/product-types", s.Cookie, body("other")),
			"update":  api.Put(path, s.Cookie, updateBody(pt, body("gateway"))),
			"delete":  api.Delete(path, s.Cookie),
			"reorder": api.Put("/api/product-types/order", s.Cookie, map[string]any{"ids": []string{pt.ID}}),
		}
		for op, resp := range writes {
			if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), `"permission":"catalog.write"`) {
				t.Errorf("%s %s: got %d: %s", name, op, resp.Code, resp.Body)
			}
		}
	}
	if items := list(t, api, api.Admin.Cookie, ""); !items[0].Can.Update || !items[0].Can.Delete {
		t.Errorf("admin can flags: %+v", items[0].Can)
	}
}

func TestKey(t *testing.T) {
	api := apptest.New(t)
	create(t, api, body("gateway"))

	resp := api.Post("/api/product-types", api.Admin.Cookie, body("gateway"))
	if resp.Code != http.StatusConflict {
		t.Fatalf("duplicate: got %d: %s", resp.Code, resp.Body)
	}
	if p := decode[problem](t, resp); p.Code != "product_type.key_taken" || p.Params["key"] != "gateway" {
		t.Errorf("duplicate: %+v", p)
	}

	other := create(t, api, body("switch"))
	resp = api.Put("/api/product-types/"+other.ID, api.Admin.Cookie, updateBody(other, body("gateway")))
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.key_taken" {
		t.Errorf("update to a taken key: got %d: %s", resp.Code, resp.Body)
	}

	for _, key := range []string{"Gateway", "1gateway", "gate-way", "gate way", "", "a" + strings.Repeat("b", 64)} {
		resp := api.Post("/api/product-types", api.Admin.Cookie, body(key))
		assertFields(t, resp, "body.key product_type.key_format")
	}
}

func TestValidation(t *testing.T) {
	api := apptest.New(t)
	attr := func(fields map[string]any) map[string]any {
		a := map[string]any{"key": "a", "label": map[string]string{"en": "A"}, "type": "text"}
		for k, v := range fields {
			a[k] = v
		}
		return a
	}
	option := func(key, en string) map[string]any {
		return map[string]any{"key": key, "label": map[string]string{"en": en}}
	}

	cases := map[string]struct {
		change func(b map[string]any)
		want   []string
	}{
		"english name": {func(b map[string]any) {
			b["name"] = map[string]string{"de": "Dimmaktor"}
		}, []string{"body.name.en validation.required"}},
		"english description": {func(b map[string]any) {
			b["description"] = map[string]string{"de": "Beschreibung"}
		}, []string{"body.description.en validation.required"}},
		"attribute key format and duplicate": {func(b map[string]any) {
			b["attributes"] = []any{attr(nil), attr(map[string]any{"key": "Bad"}), attr(nil)}
		}, []string{"body.attributes[1].key attribute.key_format", "body.attributes[2].key attribute.key_duplicate"}},
		"attribute label": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"label": map[string]string{"de": "A"}})}
		}, []string{"body.attributes[0].label.en attribute.label_required"}},
		"enum options": {func(b map[string]any) {
			b["attributes"] = []any{
				attr(map[string]any{"type": "enum"}),
				attr(map[string]any{"key": "b", "type": "enum", "options": []any{option("x", "X"), option("x", "Y"), option("Y", "Y"), option("z", "")}}),
			}
		}, []string{
			"body.attributes[0].options attribute.options_required",
			"body.attributes[1].options[1].key attribute.option_key_duplicate",
			"body.attributes[1].options[2].key attribute.key_format",
			"body.attributes[1].options[3].label.en attribute.label_required",
		}},
		"list item type": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"type": "list"})}
		}, []string{"body.attributes[0].itemType attribute.item_type_required"}},
		"range": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"type": "number", "min": 5, "max": 1})}
		}, []string{"body.attributes[0].max attribute.range_invalid"}},
		"bounds": {func(b map[string]any) {
			b["attributes"] = []any{
				attr(map[string]any{"type": "integer", "min": 0.5, "max": 1e16}),
				attr(map[string]any{"key": "b", "type": "list", "itemType": "text", "min": -1}),
			}
		}, []string{
			"body.attributes[0].min attribute.bound_whole",
			"body.attributes[0].max attribute.bound_range",
			"body.attributes[1].min attribute.bound_negative",
		}},
		"impossible schemas": {func(b map[string]any) {
			b["attributes"] = []any{
				attr(map[string]any{"required": true, "max": 0}),
				attr(map[string]any{"key": "b", "type": "list", "itemType": "enum", "min": 2, "options": []any{option("x", "X")}}),
			}
		}, []string{
			"body.attributes[0].max attribute.required_max",
			"body.attributes[1].min attribute.min_above_options",
		}},
		"instance attribute scope (not in the API schema)": {func(b map[string]any) {
			b["instanceAttributes"] = []any{attr(map[string]any{"scope": "variant"})}
		}, []string{"body.instanceAttributes[0].scope validation.invalid"}},
		"empty scope (OpenAPI enum)": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"scope": ""})}
		}, []string{"body.attributes[0].scope validation.invalid"}},
		"empty item type (OpenAPI enum)": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"type": "list", "itemType": ""})}
		}, []string{"body.attributes[0].itemType validation.invalid"}},
		"unknown locales": {func(b map[string]any) {
			b["name"] = map[string]string{"en": "Dimmer", "fr": "Variateur"}
			b["description"] = map[string]string{"en": "x", "es": "x"}
			b["attributes"] = []any{attr(map[string]any{"label": map[string]string{"en": "A", "it": "A"}})}
		}, []string{
			"body.name.fr validation.locale",
			"body.description.es validation.locale",
			"body.attributes[0].label.it validation.locale",
		}},
		"too long texts": {func(b map[string]any) {
			b["name"] = map[string]string{"en": strings.Repeat("x", 101)}
			b["description"] = map[string]string{"en": "x", "de": strings.Repeat("x", 2001)}
		}, []string{"body.name.en validation.too_long", "body.description.de validation.too_long"}},
		"colour": {func(b map[string]any) {
			b["color"] = "#12345g"
		}, []string{"body.color product_type.color_format"}},
		"too many attributes": {func(b map[string]any) {
			b["attributes"] = make([]any, 201)
			b["instanceAttributes"] = make([]any, 201)
			for i := range 201 {
				b["attributes"].([]any)[i] = attr(nil)
				b["instanceAttributes"].([]any)[i] = attr(nil)
			}
		}, []string{"body.attributes validation.too_many", "body.instanceAttributes validation.too_many"}},
		"too many options": {func(b map[string]any) {
			options := make([]any, 501)
			for i := range options {
				options[i] = option("x", "X")
			}
			b["attributes"] = []any{attr(map[string]any{"type": "enum", "options": options})}
		}, []string{"body.attributes[0].options validation.too_many"}},
		"all errors at once": {func(b map[string]any) {
			b["key"] = "Bad"
			b["attributes"] = []any{attr(map[string]any{"type": "enum"})}
			b["instanceAttributes"] = []any{attr(map[string]any{"key": ""})}
		}, []string{
			"body.key product_type.key_format",
			"body.attributes[0].options attribute.options_required",
			"body.instanceAttributes[0].key attribute.key_format",
		}},
		"unknown type (OpenAPI enum)": {func(b map[string]any) {
			b["attributes"] = []any{attr(map[string]any{"type": "date"})}
		}, []string{"body.attributes[0].type validation.invalid"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			b := body("dimmer")
			tc.change(b)
			assertFields(t, api.Post("/api/product-types", api.Admin.Cookie, b), tc.want...)
		})
	}
}

func TestIncludeInactive(t *testing.T) {
	api := apptest.New(t)
	create(t, api, body("b_active"))
	inactive := body("a_inactive")
	inactive["isActive"] = false
	create(t, api, inactive)

	if got := keys(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"b_active"}) {
		t.Errorf("default: %v", got)
	}
	if got := keys(list(t, api, api.Admin.Cookie, "?includeInactive=true")); !reflect.DeepEqual(got, []string{"b_active", "a_inactive"}) {
		t.Errorf("includeInactive: %v", got)
	}
}

func TestReorder(t *testing.T) {
	api := apptest.New(t)
	a := create(t, api, body("a"))
	b := create(t, api, body("b"))
	cBody := body("c")
	cBody["isActive"] = false
	c := create(t, api, cBody)

	resp := api.Put("/api/product-types/order", api.Admin.Cookie, map[string]any{"ids": []string{c.ID, a.ID, b.ID}})
	if resp.Code != http.StatusOK {
		t.Fatalf("reorder: got %d: %s", resp.Code, resp.Body)
	}
	items := decode[struct{ Items []productType }](t, resp).Items
	if got := keys(items); !reflect.DeepEqual(got, []string{"c", "a", "b"}) {
		t.Errorf("reorder result: %v", got)
	}
	for i, it := range items {
		if it.SortOrder != i+1 {
			t.Errorf("%s: sort order %d, want %d", it.Key, it.SortOrder, i+1)
		}
	}
	if got := keys(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("list after reorder: %v", got)
	}
	if d := create(t, api, body("d")); d.SortOrder != 4 {
		t.Errorf("new type after reorder: sort order %d, want 4", d.SortOrder)
	}

	const unknown = "00000000-0000-0000-0000-000000000001"
	all := []string{c.ID, a.ID, b.ID}
	mismatches := map[string][]string{
		"missing one": all,
		"duplicate":   {c.ID, a.ID, b.ID, a.ID},
		"unknown":     {c.ID, a.ID, b.ID, unknown},
		"empty":       {},
	}
	for name, ids := range mismatches {
		resp := api.Put("/api/product-types/order", api.Admin.Cookie, map[string]any{"ids": ids})
		if resp.Code != http.StatusUnprocessableEntity || decode[problem](t, resp).Code != "product_type.order_mismatch" {
			t.Errorf("%s: got %d: %s", name, resp.Code, resp.Body)
		}
	}
	// A failed reorder changes nothing.
	if got := keys(list(t, api, api.Admin.Cookie, "?includeInactive=true")); !reflect.DeepEqual(got, []string{"c", "a", "b", "d"}) {
		t.Errorf("after failed reorders: %v", got)
	}
}

func TestDeleteInUse(t *testing.T) {
	api := apptest.New(t)
	pt := create(t, api, body("gateway"))
	// Products arrive in step 1c with a RESTRICT foreign key; simulate one.
	ctx := context.Background()
	if _, err := api.DB.Exec(ctx, `CREATE TABLE fk_test (product_type_id uuid NOT NULL REFERENCES product_types (id) ON DELETE RESTRICT)`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = api.DB.Exec(context.Background(), `DROP TABLE fk_test`) })
	if _, err := api.DB.Exec(ctx, `INSERT INTO fk_test VALUES ($1)`, pt.ID); err != nil {
		t.Fatal(err)
	}

	resp := api.Delete("/api/product-types/"+pt.ID, api.Admin.Cookie)
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.in_use" {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
}

func TestNotFound(t *testing.T) {
	api := apptest.New(t)
	const missing = "/api/product-types/00000000-0000-0000-0000-000000000001"

	for name, resp := range map[string]*httptest.ResponseRecorder{
		"get":    api.Get(missing, api.Admin.Cookie),
		"update": api.Put(missing, api.Admin.Cookie, updateBody(productType{UpdatedAt: time.Now().Format(time.RFC3339)}, body("x"))),
		"delete": api.Delete(missing, api.Admin.Cookie),
	} {
		if resp.Code != http.StatusNotFound || decode[problem](t, resp).Code != "product_type.not_found" {
			t.Errorf("%s: got %d: %s", name, resp.Code, resp.Body)
		}
	}
}

// assertFields checks for a 422 with exactly these "location code" field errors.
func assertFields(t *testing.T, resp *httptest.ResponseRecorder, want ...string) {
	t.Helper()
	if resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d, want 422: %s", resp.Code, resp.Body)
	}
	got := []string{}
	for _, f := range decode[problem](t, resp).Fields {
		got = append(got, f.Location+" "+f.Code)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("fields %q\nwant %q", got, want)
	}
}

func TestNormalisesOnSave(t *testing.T) {
	api := apptest.New(t)
	b := body("dimmer")
	b["color"] = " #1F6FEB "
	b["attributes"] = []any{
		map[string]any{"key": "name", "label": map[string]string{"en": " Name "}, "type": "text",
			"options": []any{map[string]any{"key": "x", "label": map[string]string{"en": "X"}}}, "itemType": "enum"},
		map[string]any{"key": "on", "label": map[string]string{"en": "On"}, "type": "boolean", "min": 1, "max": 2},
	}
	got := create(t, api, b)
	want := []map[string]any{
		{"key": "name", "label": map[string]any{"en": "Name"}, "type": "text", "scope": "product"},
		{"key": "on", "label": map[string]any{"en": "On"}, "type": "boolean", "scope": "product"},
	}
	if !reflect.DeepEqual(got.Attributes, want) {
		t.Errorf("attributes: %v", got.Attributes)
	}
	if got.Color != "#1f6feb" {
		t.Errorf("colour: %q", got.Color)
	}

	// No colour clears it.
	resp := api.Put("/api/product-types/"+got.ID, api.Admin.Cookie, updateBody(got, body("dimmer")))
	if updated := decode[productType](t, resp); resp.Code != http.StatusOK || updated.Color != "" {
		t.Errorf("clear colour: got %d: %s", resp.Code, resp.Body)
	}
}

func TestErrorParams(t *testing.T) {
	api := apptest.New(t)
	b := body("dimmer")
	b["name"] = map[string]string{"en": strings.Repeat("x", 101)}
	b["attributes"] = []any{
		map[string]any{"key": "a", "label": map[string]string{"en": "A"}, "type": "number", "min": 5, "max": 1},
	}
	resp := api.Post("/api/product-types", api.Admin.Cookie, b)
	p := decode[problem](t, resp)
	if resp.Code != http.StatusUnprocessableEntity || len(p.Fields) != 2 {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	if !reflect.DeepEqual(p.Fields[0].Params, map[string]any{"max": 100.0}) ||
		!reflect.DeepEqual(p.Fields[1].Params, map[string]any{"min": 5.0}) {
		t.Errorf("params: %+v", p.Fields)
	}
}

func TestStaleUpdate(t *testing.T) {
	api := apptest.New(t)
	pt := create(t, api, body("dimmer"))
	path := "/api/product-types/" + pt.ID

	first := api.Put(path, api.Admin.Cookie, updateBody(pt, body("dimmer_a")))
	if first.Code != http.StatusOK {
		t.Fatalf("first update: got %d: %s", first.Code, first.Body)
	}
	updated := decode[productType](t, first)
	if updated.UpdatedAt == pt.UpdatedAt {
		t.Error("updatedAt did not change")
	}

	// A second editor still holds the old version.
	resp := api.Put(path, api.Admin.Cookie, updateBody(pt, body("dimmer_b")))
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.stale" {
		t.Fatalf("stale update: got %d: %s", resp.Code, resp.Body)
	}
	if got := keys(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"dimmer_a"}) {
		t.Errorf("after stale update: %v", got)
	}

	// With the current version it works again.
	if resp := api.Put(path, api.Admin.Cookie, updateBody(updated, body("dimmer_b"))); resp.Code != http.StatusOK {
		t.Errorf("fresh update: got %d: %s", resp.Code, resp.Body)
	}

	// expectedUpdatedAt is required (huma reports a missing property at "body").
	resp = api.Put(path, api.Admin.Cookie, body("dimmer_c"))
	assertFields(t, resp, "body validation.invalid")

	// Concurrent saves of the same version: exactly one wins.
	current := decode[productType](t, api.Get(path, api.Admin.Cookie))
	codes := make([]int, 10)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Go(func() {
			codes[i] = api.Put(path, api.Admin.Cookie, updateBody(current, body("dimmer_c"))).Code
		})
	}
	wg.Wait()
	ok := 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
		default:
			t.Errorf("concurrent update: got %d", c)
		}
	}
	if ok != 1 {
		t.Errorf("%d concurrent updates succeeded, want 1 (%v)", ok, codes)
	}
}

func TestConcurrentSortOrder(t *testing.T) {
	api := apptest.New(t)
	const n = 20
	var wg sync.WaitGroup
	results := make([]productType, n)
	for i := range n {
		wg.Go(func() {
			resp := api.Post("/api/product-types", api.Admin.Cookie, body(fmt.Sprintf("type_%02d", i)))
			if resp.Code == http.StatusCreated {
				_ = json.Unmarshal(resp.Body.Bytes(), &results[i])
			}
		})
	}
	wg.Wait()
	seen := map[int]bool{}
	for i, r := range results {
		if r.ID == "" {
			t.Fatalf("create %d failed", i)
		}
		if seen[r.SortOrder] {
			t.Errorf("sort order %d given twice", r.SortOrder)
		}
		seen[r.SortOrder] = true
	}
	for i := 1; i <= n; i++ {
		if !seen[i] {
			t.Errorf("sort order %d missing", i)
		}
	}

	// Creates during reorders: every reorder sees a complete list or reports
	// a mismatch, and sort orders stay distinct.
	items := list(t, api, api.Admin.Cookie, "?includeInactive=true")
	ids := make([]string, len(items))
	for i, it := range items {
		ids[len(items)-1-i] = it.ID
	}
	wg = sync.WaitGroup{}
	reorderCodes := make([]int, 5)
	for i := range reorderCodes {
		wg.Go(func() {
			reorderCodes[i] = api.Put("/api/product-types/order", api.Admin.Cookie, map[string]any{"ids": ids}).Code
		})
		wg.Go(func() { create(t, api, body(fmt.Sprintf("late_%d", i))) })
	}
	wg.Wait()
	for _, c := range reorderCodes {
		if c != http.StatusOK && c != http.StatusUnprocessableEntity {
			t.Errorf("reorder: got %d", c)
		}
	}
	all := list(t, api, api.Admin.Cookie, "?includeInactive=true")
	seen = map[int]bool{}
	for _, it := range all {
		if seen[it.SortOrder] {
			t.Errorf("sort order %d given twice after reorders: %v", it.SortOrder, keys(all))
		}
		seen[it.SortOrder] = true
	}
	if len(all) != n+5 {
		t.Errorf("%d types, want %d", len(all), n+5)
	}
}
