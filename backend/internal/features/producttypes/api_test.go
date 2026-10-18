package producttypes_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

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
	SortOrder          int              `json:"sortOrder"`
	IsActive           bool             `json:"isActive"`
	Attributes         []map[string]any `json:"attributes"`
	InstanceAttributes []map[string]any `json:"instanceAttributes"`
	Can                auth.Actions     `json:"can"`
}

type problem struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params"`
	Fields []struct {
		Location string `json:"location"`
		Code     string `json:"code"`
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

	upd := body("dimmer")
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
			"update":  api.Put(path, s.Cookie, body("gateway")),
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
	resp = api.Put("/api/product-types/"+other.ID, api.Admin.Cookie, body("gateway"))
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.key_taken" {
		t.Errorf("update to a taken key: got %d: %s", resp.Code, resp.Body)
	}

	for _, key := range []string{"Gateway", "1gateway", "gate-way", "gate way"} {
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
		"instance attribute scope": {func(b map[string]any) {
			b["instanceAttributes"] = []any{attr(map[string]any{"scope": "variant"})}
		}, []string{"body.instanceAttributes[0].scope attribute.scope_not_allowed"}},
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
		"update": api.Put(missing, api.Admin.Cookie, body("x")),
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
