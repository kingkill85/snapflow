package producttypes_test

import (
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
	ID           string         `json:"id"`
	Key          string         `json:"key"`
	Name         map[string]any `json:"name"`
	Abbreviation string         `json:"abbreviation"`
	Color        string         `json:"color"`
	SortOrder    int            `json:"sortOrder"`
	IsActive     bool           `json:"isActive"`
	Can          auth.Actions   `json:"can"`
	UpdatedAt    string         `json:"updatedAt"`
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
		"key":      key,
		"name":     map[string]string{"en": "Zigbee", "de": "Zigbee"},
		"isActive": true,
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

	b := body("zigbee")
	b["abbreviation"] = "ZB"
	b["color"] = "#1f6feb"
	created := create(t, api, b)
	if created.SortOrder != 1 || !created.IsActive || !created.Can.Update || !created.Can.Delete ||
		created.Abbreviation != "ZB" || created.Color != "#1f6feb" || created.Name["de"] != "Zigbee" {
		t.Errorf("created: %+v", created)
	}

	resp := api.Get("/api/product-types/"+created.ID, api.Admin.Cookie)
	got := decode[productType](t, resp)
	if resp.Code != http.StatusOK || !reflect.DeepEqual(got, created) {
		t.Fatalf("get: got %d: %+v", resp.Code, got)
	}

	second := create(t, api, body("knx"))
	if second.SortOrder != 2 {
		t.Errorf("second type got sort order %d, want 2", second.SortOrder)
	}

	upd := updateBody(created, body("zigbee_3"))
	upd["isActive"] = false
	resp = api.Put("/api/product-types/"+created.ID, api.Admin.Cookie, upd)
	if resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	updated := decode[productType](t, resp)
	if updated.Key != "zigbee_3" || updated.IsActive || updated.SortOrder != 1 || updated.Abbreviation != "" || updated.Color != "" {
		t.Errorf("updated: %+v", updated)
	}

	if resp := api.Delete("/api/product-types/"+created.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d: %s", resp.Code, resp.Body)
	}
	if got := keys(list(t, api, api.Admin.Cookie, "?includeInactive=true")); !reflect.DeepEqual(got, []string{"knx"}) {
		t.Errorf("after delete: %v", got)
	}
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	pt := create(t, api, body("zigbee"))
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
			"update":  api.Put(path, s.Cookie, updateBody(pt, body("zigbee"))),
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
	create(t, api, body("zigbee"))

	resp := api.Post("/api/product-types", api.Admin.Cookie, body("zigbee"))
	if resp.Code != http.StatusConflict {
		t.Fatalf("duplicate: got %d: %s", resp.Code, resp.Body)
	}
	if p := decode[problem](t, resp); p.Code != "product_type.key_taken" || p.Params["key"] != "zigbee" {
		t.Errorf("duplicate: %+v", p)
	}

	other := create(t, api, body("switch"))
	resp = api.Put("/api/product-types/"+other.ID, api.Admin.Cookie, updateBody(other, body("zigbee")))
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
	cases := map[string]struct {
		change func(b map[string]any)
		want   []string
	}{
		"english name": {func(b map[string]any) {
			b["name"] = map[string]string{"de": "Zigbee"}
		}, []string{"body.name.en validation.required"}},
		"unknown locales": {func(b map[string]any) {
			b["name"] = map[string]string{"en": "Zigbee", "fr": "Zigbee"}
		}, []string{"body.name.fr validation.locale"}},
		"too long name": {func(b map[string]any) {
			b["name"] = map[string]string{"en": strings.Repeat("x", 101)}
		}, []string{"body.name.en validation.too_long"}},
		"too long abbreviation": {func(b map[string]any) {
			b["abbreviation"] = "ABCDEFG"
		}, []string{"body.abbreviation validation.too_long"}},
		"control characters in the abbreviation": {func(b map[string]any) {
			b["abbreviation"] = "Z\u200bB"
		}, []string{"body.abbreviation validation.control_chars"}},
		"colour": {func(b map[string]any) {
			b["color"] = "#12345g"
		}, []string{"body.color product_type.color_format"}},
		"all errors at once": {func(b map[string]any) {
			b["key"] = "Bad"
			b["name"] = map[string]string{}
			b["abbreviation"] = "TOOLONG"
			b["color"] = "red"
		}, []string{
			"body.key product_type.key_format",
			"body.name.en validation.required",
			"body.abbreviation validation.too_long",
			"body.color product_type.color_format",
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			b := body("zigbee")
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
	pt := create(t, api, body("zigbee"))
	resp := api.Post("/api/categories", api.Admin.Cookie, map[string]any{
		"key": "gateways", "name": map[string]string{"en": "Gateways"}, "isActive": true,
		"attributes": []any{}, "instanceAttributes": []any{},
	})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create category: got %d: %s", resp.Code, resp.Body)
	}
	c := decode[struct{ ID string }](t, resp)
	resp = api.Post("/api/products", api.Admin.Cookie, map[string]any{
		"productTypeId": pt.ID, "categoryId": c.ID, "modelNumber": "GW-1", "name": map[string]string{"en": "Gateway"}, "isActive": false,
	})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create product: got %d: %s", resp.Code, resp.Body)
	}
	product := decode[struct{ ID string }](t, resp)

	// Any product, active or not, keeps its type (FK RESTRICT).
	resp = api.Delete("/api/product-types/"+pt.ID, api.Admin.Cookie)
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.in_use" {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	if resp := api.Get("/api/product-types/"+pt.ID, api.Admin.Cookie); resp.Code != http.StatusOK {
		t.Errorf("type gone: got %d", resp.Code)
	}

	// Without products it can be deleted.
	if resp := api.Delete("/api/products/"+product.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete product: got %d: %s", resp.Code, resp.Body)
	}
	if resp := api.Delete("/api/product-types/"+pt.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Errorf("delete type: got %d: %s", resp.Code, resp.Body)
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
	b := body("zigbee")
	b["color"] = " #1F6FEB "
	b["abbreviation"] = " zbé "
	b["name"] = map[string]string{"en": " Zigbee ", "de": ""}
	got := create(t, api, b)
	if got.Color != "#1f6feb" || got.Abbreviation != "ZBÉ" || !reflect.DeepEqual(got.Name, map[string]any{"en": "Zigbee"}) {
		t.Errorf("normalised: %+v", got)
	}
	// Six characters, not bytes.
	b = body("knx")
	b["abbreviation"] = "äöüäöü"
	if got := create(t, api, b); got.Abbreviation != "ÄÖÜÄÖÜ" {
		t.Errorf("umlauts: %q", got.Abbreviation)
	}

	// Per character like the frontend's preview: "ß" has no single upper-case
	// character and stays.
	b = body("hdl")
	b["abbreviation"] = "ßx"
	if got := create(t, api, b); got.Abbreviation != "ßX" {
		t.Errorf("sharp s: %q", got.Abbreviation)
	}

	// No colour or abbreviation clears them; blank is none.
	nb := updateBody(got, body("zigbee"))
	nb["abbreviation"] = "   "
	resp := api.Put("/api/product-types/"+got.ID, api.Admin.Cookie, nb)
	if updated := decode[productType](t, resp); resp.Code != http.StatusOK || updated.Color != "" || updated.Abbreviation != "" {
		t.Errorf("clear: got %d: %s", resp.Code, resp.Body)
	}
}

func TestErrorParams(t *testing.T) {
	api := apptest.New(t)
	b := body("zigbee")
	b["name"] = map[string]string{"en": strings.Repeat("x", 101)}
	b["abbreviation"] = "ABCDEFG"
	resp := api.Post("/api/product-types", api.Admin.Cookie, b)
	p := decode[problem](t, resp)
	if resp.Code != http.StatusUnprocessableEntity || len(p.Fields) != 2 {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	if !reflect.DeepEqual(p.Fields[0].Params, map[string]any{"max": 100.0}) ||
		!reflect.DeepEqual(p.Fields[1].Params, map[string]any{"max": 6.0}) {
		t.Errorf("params: %+v", p.Fields)
	}
}

func TestStaleUpdate(t *testing.T) {
	api := apptest.New(t)
	pt := create(t, api, body("zigbee"))
	path := "/api/product-types/" + pt.ID

	first := api.Put(path, api.Admin.Cookie, updateBody(pt, body("zigbee_a")))
	if first.Code != http.StatusOK {
		t.Fatalf("first update: got %d: %s", first.Code, first.Body)
	}
	updated := decode[productType](t, first)
	if updated.UpdatedAt == pt.UpdatedAt {
		t.Error("updatedAt did not change")
	}

	// A second editor still holds the old version.
	resp := api.Put(path, api.Admin.Cookie, updateBody(pt, body("zigbee_b")))
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "product_type.stale" {
		t.Fatalf("stale update: got %d: %s", resp.Code, resp.Body)
	}
	if got := keys(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"zigbee_a"}) {
		t.Errorf("after stale update: %v", got)
	}

	// With the current version it works again.
	if resp := api.Put(path, api.Admin.Cookie, updateBody(updated, body("zigbee_b"))); resp.Code != http.StatusOK {
		t.Errorf("fresh update: got %d: %s", resp.Code, resp.Body)
	}

	// expectedUpdatedAt is required (huma reports a missing property at "body").
	resp = api.Put(path, api.Admin.Cookie, body("zigbee_c"))
	assertFields(t, resp, "body validation.invalid")

	// Concurrent saves of the same version: exactly one wins.
	current := decode[productType](t, api.Get(path, api.Admin.Cookie))
	codes := make([]int, 10)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Go(func() {
			codes[i] = api.Put(path, api.Admin.Cookie, updateBody(current, body("zigbee_c"))).Code
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
