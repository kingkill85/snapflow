package products_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
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

const missing = "00000000-0000-0000-0000-000000000001"

func TestProductCRUD(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())

	b := dimmerBody(pt.ID, "  M485/GW-ZB.10  ")
	b["description"] = map[string]string{"en": " DIN rail dimmer ", "de": ""}
	b["attributes"] = map[string]any{"width_te": 4, "bus_system": " zigbee "}
	p := newProduct(t, api, b)
	if p.ModelNumber != "M485/GW-ZB.10" || p.ProductTypeID != pt.ID || !p.IsActive || !p.Available ||
		!p.Can.Update || !p.Can.Delete || len(p.Variants) != 0 {
		t.Errorf("created: %+v", p)
	}
	if !reflect.DeepEqual(p.ProductType, typeRef{ID: pt.ID, Key: "dimmer", Name: map[string]any{"en": "dimmer"}, Color: "#1f6feb", IsActive: true}) {
		t.Errorf("type ref: %+v", p.ProductType)
	}
	if !reflect.DeepEqual(p.Description, map[string]any{"en": "DIN rail dimmer"}) {
		t.Errorf("description: %v", p.Description)
	}
	if !reflect.DeepEqual(p.Attributes, map[string]any{"width_te": 4.0, "bus_system": "zigbee"}) ||
		len(p.StaleAttributes) != 0 || p.AttributeErrors == nil || len(p.AttributeErrors) != 0 {
		t.Errorf("attributes: %v stale %v errors %v", p.Attributes, p.StaleAttributes, p.AttributeErrors)
	}
	if got := getProduct(t, api, p.ID); !reflect.DeepEqual(got, p) {
		t.Errorf("get: %+v\nwant %+v", got, p)
	}

	upd := dimmerBody(pt.ID, "M485/GW-ZB.11")
	upd["isActive"] = false
	resp := update(api, p, upd)
	if resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	updated := decode[product](t, resp)
	if updated.ModelNumber != "M485/GW-ZB.11" || updated.IsActive || updated.Available || updated.Description != nil ||
		updated.UpdatedAt == p.UpdatedAt {
		t.Errorf("updated: %+v", updated)
	}

	if resp := api.Delete("/api/products/"+p.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d: %s", resp.Code, resp.Body)
	}
	assertError(t, api.Get("/api/products/"+p.ID, api.Admin.Cookie), http.StatusNotFound, "product.not_found")
	assertError(t, api.Delete("/api/products/"+p.ID, api.Admin.Cookie), http.StatusNotFound, "product.not_found")
	assertError(t, update(api, p, dimmerBody(pt.ID, "X")), http.StatusNotFound, "product.not_found")
}

func TestProductValidation(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())

	b := dimmerBody(pt.ID, "  ")
	b["name"] = map[string]string{"de": "Nur Deutsch", "fr": "x"}
	b["description"] = map[string]string{"de": strings.Repeat("x", 5001)}
	b["attributes"] = map[string]any{"width_te": 30, "bus_system": "dali", "colour": "red", "typo": 1}
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, b),
		"body.modelNumber validation.required",
		"body.name.fr validation.locale",
		"body.name.en validation.required",
		"body.description.de validation.too_long",
		"body.description.en validation.required",
		"body.attributes.width_te attribute.range",
		"body.attributes.bus_system attribute.option",
		"body.attributes.colour attribute.wrong_scope",
		"body.attributes.typo attribute.unknown",
	)

	// A required attribute; a too long model number; an unknown type
	// (attributes are not checked without a type).
	b = dimmerBody(pt.ID, strings.Repeat("M", 101))
	b["attributes"] = map[string]any{}
	resp := api.Post("/api/products", api.Admin.Cookie, b)
	assertFields(t, resp, "body.modelNumber validation.too_long", "body.attributes.width_te attribute.required")
	if p := decode[problem](t, resp); p.Fields[0].Params["max"] != 100.0 {
		t.Errorf("params: %+v", p.Fields[0])
	}
	b = productBody(missing, "M1")
	b["attributes"] = map[string]any{"anything": 1}
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, b), "body.productTypeId product.type_not_found")

	// Attributes may be left out when nothing is required.
	free := newType(t, api, "free", []any{})
	b = productBody(free.ID, "M2")
	delete(b, "attributes")
	if p := newProduct(t, api, b); len(p.Attributes) != 0 {
		t.Errorf("attributes: %v", p.Attributes)
	}
}

func TestModelNumberUnique(t *testing.T) {
	api := apptest.New(t)
	a := newType(t, api, "a", []any{})
	b := newType(t, api, "b", []any{})
	first := newProduct(t, api, productBody(a.ID, "GW-1"))
	other := newProduct(t, api, productBody(a.ID, "GW-2"))

	// Unique across the whole catalog, ignoring case and surrounding space.
	for _, model := range []string{"GW-1", "gw-1", " Gw-1 "} {
		for _, typeID := range []string{a.ID, b.ID} {
			p := assertError(t, api.Post("/api/products", api.Admin.Cookie, productBody(typeID, model)),
				http.StatusConflict, "product.model_number_taken")
			if p.Params["modelNumber"] != strings.TrimSpace(model) {
				t.Errorf("params: %v", p.Params)
			}
		}
	}
	assertError(t, update(api, other, productBody(a.ID, "GW-1")), http.StatusConflict, "product.model_number_taken")
	// Changing only the case of its own model number is fine.
	if resp := update(api, first, productBody(a.ID, "gw-1")); resp.Code != http.StatusOK {
		t.Errorf("own model number: got %d: %s", resp.Code, resp.Body)
	}
	// Names are not unique.
	b2 := productBody(a.ID, "GW-3")
	b2["name"] = map[string]string{"en": "Dimmer GW-1"}
	newProduct(t, api, b2)
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	p := newProduct(t, api, dimmerBody(pt.ID, "M1"))
	v := quickVariant(t, api, p.ID, "1.00")
	partner := api.NewTenant("Partner")
	base := "/api/products/" + p.ID
	vpath := base + "/variants/" + v.ID

	for name, path := range map[string]string{"list": "/api/products", "get": base, "variants": "/api/variants"} {
		if resp := api.Get(path); resp.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s: got %d", name, resp.Code)
		}
	}
	for _, role := range []auth.Role{auth.RoleUser, auth.RoleTenantAdmin} {
		s := api.NewUser(partner, role)
		items := list(t, api, s.Cookie, "").Items
		if len(items) != 1 || items[0].Can.Update || items[0].Can.Delete {
			t.Errorf("%s list: %+v", role, items)
		}
		resp := api.Get(base, s.Cookie)
		got := decode[product](t, resp)
		if resp.Code != http.StatusOK || got.Can.Update || got.Variants[0].Can.Update || got.Variants[0].Can.Delete {
			t.Errorf("%s get: got %d: %+v", role, resp.Code, got)
		}
		if resp := api.Get("/api/variants", s.Cookie); resp.Code != http.StatusOK {
			t.Errorf("%s variant search: got %d", role, resp.Code)
		}
		writes := map[string]*httptest.ResponseRecorder{
			"create product": api.Post("/api/products", s.Cookie, dimmerBody(pt.ID, "M2")),
			"update product": api.Put(base, s.Cookie, map[string]any{
				"productTypeId": pt.ID, "modelNumber": "M1", "name": text("x"), "isActive": true, "expectedUpdatedAt": p.UpdatedAt,
			}),
			"delete product": api.Delete(base, s.Cookie),
			"create variant": api.Post(base+"/variants", s.Cookie, variantBody("x", "1")),
			"update variant": api.Put(vpath, s.Cookie, map[string]any{
				"name": text("x"), "price": "1", "isActive": true, "expectedUpdatedAt": v.UpdatedAt,
			}),
			"delete variant":  api.Delete(vpath, s.Cookie),
			"reorder":         api.Put(base+"/variants/order", s.Cookie, map[string]any{"ids": []string{v.ID}}),
			"replace add-ons": api.Put(vpath+"/addons", s.Cookie, map[string]any{"addons": []any{}}),
		}
		for op, resp := range writes {
			if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), `"permission":"catalog.write"`) {
				t.Errorf("%s %s: got %d: %s", role, op, resp.Code, resp.Body)
			}
		}
	}
	// Nothing changed.
	if got := getProduct(t, api, p.ID); len(got.Variants) != 1 || got.ModelNumber != "M1" {
		t.Errorf("after forbidden writes: %+v", got)
	}
}

func TestStaleUpdates(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	p := newProduct(t, api, dimmerBody(pt.ID, "M1"))

	first := update(api, p, dimmerBody(pt.ID, "M1-a"))
	if first.Code != http.StatusOK {
		t.Fatalf("first update: got %d: %s", first.Code, first.Body)
	}
	assertError(t, update(api, p, dimmerBody(pt.ID, "M1-b")), http.StatusConflict, "product.stale")
	if got := getProduct(t, api, p.ID); got.ModelNumber != "M1-a" {
		t.Errorf("after stale update: %s", got.ModelNumber)
	}
	// expectedUpdatedAt is required.
	assertFields(t, api.Put("/api/products/"+p.ID, api.Admin.Cookie, dimmerBody(pt.ID, "M1-c")), "body validation.invalid")

	v := quickVariant(t, api, p.ID, "1.00")
	resp := updateVariant(api, v, variantBody("Ivory", "2.00"))
	if resp.Code != http.StatusOK {
		t.Fatalf("variant update: got %d: %s", resp.Code, resp.Body)
	}
	if decode[variant](t, resp).UpdatedAt == v.UpdatedAt {
		t.Error("variant updatedAt did not change")
	}
	assertError(t, updateVariant(api, v, variantBody("White", "3.00")), http.StatusConflict, "variant.stale")

	// Concurrent saves of the same version: exactly one wins.
	current := getProduct(t, api, p.ID)
	cv := current.Variants[0]
	pCodes, vCodes := make([]int, 8), make([]int, 8)
	var wg sync.WaitGroup
	for i := range pCodes {
		wg.Go(func() { pCodes[i] = update(api, current, dimmerBody(pt.ID, fmt.Sprintf("M1-%d", i))).Code })
		wg.Go(func() { vCodes[i] = updateVariant(api, cv, variantBody(fmt.Sprintf("V%d", i), "1")).Code })
	}
	wg.Wait()
	for name, codes := range map[string][]int{"product": pCodes, "variant": vCodes} {
		ok := 0
		for _, c := range codes {
			switch c {
			case http.StatusOK:
				ok++
			case http.StatusConflict:
			default:
				t.Errorf("concurrent %s update: got %d", name, c)
			}
		}
		if ok != 1 {
			t.Errorf("%d concurrent %s updates succeeded, want 1 (%v)", ok, name, codes)
		}
	}
}

func TestVariants(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	p := newProduct(t, api, dimmerBody(pt.ID, "M1"))
	other := newProduct(t, api, dimmerBody(pt.ID, "M2"))
	img := uploadImage(t, api, 1)

	b := variantBody(" Ivory White ", "27")
	b["name"] = map[string]string{"en": " Ivory White ", "de": "Elfenbein"}
	b["sku"] = " M1-IVORY "
	b["imageFileId"] = img
	b["attributes"] = map[string]any{"colour": " ivory ", "finish": "matt"}
	v1 := newVariant(t, api, p.ID, b)
	if v1.ProductID != p.ID || v1.SKU != "M1-IVORY" || v1.Price != "27.00" || v1.ImageFileID != img || v1.SortOrder != 1 ||
		!v1.IsActive || !v1.Available || !v1.Can.Update || len(v1.Addons) != 0 || v1.Addons == nil ||
		!reflect.DeepEqual(v1.Name, map[string]any{"en": "Ivory White", "de": "Elfenbein"}) ||
		!reflect.DeepEqual(v1.Attributes, map[string]any{"colour": "ivory", "finish": "matt"}) {
		t.Errorf("created: %+v", v1)
	}
	v2 := newVariant(t, api, p.ID, variantBody("Black", "31.5"))
	v3 := newVariant(t, api, p.ID, variantBody("Grey", "0"))
	if v2.SortOrder != 2 || v3.SortOrder != 3 || v2.SKU != "" || v2.ImageFileID != "" {
		t.Errorf("sort orders: %d %d", v2.SortOrder, v3.SortOrder)
	}
	if got := getProduct(t, api, p.ID); len(got.Variants) != 3 || got.Variants[0].ID != v1.ID || got.Variants[2].ID != v3.ID {
		t.Errorf("product variants: %+v", got.Variants)
	}

	// Names are unique per product (English, ignoring case); SKUs across the
	// catalog (ignoring case); several variants may have no SKU.
	pr := assertError(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, variantBody("ivory white", "1")),
		http.StatusConflict, "variant.name_taken")
	if pr.Params["name"] != "ivory white" {
		t.Errorf("params: %v", pr.Params)
	}
	newVariant(t, api, other.ID, variantBody("Ivory White", "1"))
	dup := variantBody("Other", "1")
	dup["sku"] = "m1-ivory"
	pr = assertError(t, api.Post("/api/products/"+other.ID+"/variants", api.Admin.Cookie, dup), http.StatusConflict, "variant.sku_taken")
	if pr.Params["sku"] != "m1-ivory" {
		t.Errorf("params: %v", pr.Params)
	}
	assertError(t, updateVariant(api, v2, variantBody("IVORY WHITE", "1")), http.StatusConflict, "variant.name_taken")

	// Validation, all at once.
	bad := variantBody("", "1.234")
	bad["sku"] = strings.Repeat("s", 101)
	bad["imageFileId"] = missing
	bad["attributes"] = map[string]any{"finish": "shiny", "width_te": 2, "typo": true}
	assertFields(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, bad),
		"body.name.en validation.required",
		"body.sku validation.too_long",
		"body.price variant.price_format",
		"body.imageFileId file.not_found",
		"body.attributes.finish attribute.option",
		"body.attributes.width_te attribute.wrong_scope",
		"body.attributes.typo attribute.unknown",
	)

	// Update: clear the image and SKU.
	resp := updateVariant(api, v1, variantBody("Ivory White", "28.10"))
	if resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	if u := decode[variant](t, resp); u.ImageFileID != "" || u.SKU != "" || u.Price != "28.10" || u.SortOrder != 1 || len(u.Attributes) != 0 {
		t.Errorf("updated: %+v", u)
	}

	// A variant is addressed through its own product only.
	wrong := "/api/products/" + other.ID + "/variants/" + v2.ID
	assertError(t, api.Put(wrong, api.Admin.Cookie, map[string]any{
		"name": text("x"), "price": "1", "isActive": true, "expectedUpdatedAt": v2.UpdatedAt,
	}), http.StatusNotFound, "variant.not_found")
	assertError(t, api.Delete(wrong, api.Admin.Cookie), http.StatusNotFound, "variant.not_found")
	assertError(t, api.Post("/api/products/"+missing+"/variants", api.Admin.Cookie, variantBody("x", "1")),
		http.StatusNotFound, "product.not_found")

	if resp := api.Delete("/api/products/"+p.ID+"/variants/"+v2.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d", resp.Code)
	}
	if got := getProduct(t, api, p.ID); len(got.Variants) != 2 {
		t.Errorf("after delete: %+v", got.Variants)
	}
	// The name is free again.
	newVariant(t, api, p.ID, variantBody("Black", "1"))
}

func TestMoney(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))

	for in, want := range map[string]string{
		"27": "27.00", "27.5": "27.50", "27.05": "27.05", "0": "0.00", "0.00": "0.00", "007.10": "7.10",
		"9999999999.99": "9999999999.99", "1234567890": "1234567890.00",
	} {
		v := newVariant(t, api, p.ID, variantBody("v "+in, in))
		if v.Price != want {
			t.Errorf("price %q: got %q, want %q", in, v.Price, want)
		}
		if got := getProduct(t, api, p.ID); got.Variants[len(got.Variants)-1].Price != want {
			t.Errorf("price %q read back: %q", in, got.Variants[len(got.Variants)-1].Price)
		}
	}
	for _, in := range []string{".5", "1.234", "-1", "1e3", "12345678901", "", " 1", "1 ", "1.", "1,50", "NaN", "+1", "0x10", "١"} {
		assertFields(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, variantBody("bad", in)),
			"body.price variant.price_format")
	}
	// A JSON number is not a price.
	b := variantBody("number", "1")
	b["price"] = 27
	assertFields(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, b), "body.price validation.invalid")
}

func TestConcurrentVariants(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))
	other := newProduct(t, api, productBody(pt.ID, "M2"))
	const n = 10
	path := "/api/products/" + p.ID + "/variants"

	count := func(codes []int) map[int]int {
		out := map[int]int{}
		for _, c := range codes {
			out[c]++
		}
		return out
	}

	// The same name at once: one wins, the others get name_taken.
	codes := make([]int, n)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Go(func() {
			codes[i] = api.Post(path, api.Admin.Cookie, variantBody(map[bool]string{true: "Same", false: "same"}[i%2 == 0], "1")).Code
		})
	}
	wg.Wait()
	if c := count(codes); c[http.StatusCreated] != 1 || c[http.StatusConflict] != n-1 {
		t.Errorf("same name: %v", codes)
	}

	// The same SKU on two products at once.
	codes = make([]int, n)
	for i := range codes {
		wg.Go(func() {
			b := variantBody(fmt.Sprintf("sku %d", i), "1")
			b["sku"] = "SKU-1"
			target := []string{p.ID, other.ID}[i%2]
			codes[i] = api.Post("/api/products/"+target+"/variants", api.Admin.Cookie, b).Code
		})
	}
	wg.Wait()
	if c := count(codes); c[http.StatusCreated] != 1 || c[http.StatusConflict] != n-1 {
		t.Errorf("same sku: %v", codes)
	}

	// Different names at once: distinct sort orders.
	for i := range n {
		wg.Go(func() {
			if resp := api.Post(path, api.Admin.Cookie, variantBody(fmt.Sprintf("v%d", i), "1")); resp.Code != http.StatusCreated {
				t.Errorf("create %d: got %d", i, resp.Code)
			}
		})
	}
	wg.Wait()
	seen := map[int]bool{}
	got := getProduct(t, api, p.ID)
	for _, v := range got.Variants {
		if seen[v.SortOrder] {
			t.Errorf("sort order %d given twice", v.SortOrder)
		}
		seen[v.SortOrder] = true
	}
	if len(got.Variants) < n+1 { // "Same", maybe the SKU winner, and the n new ones
		t.Errorf("%d variants", len(got.Variants))
	}
}

func TestReorderVariants(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))
	other := newProduct(t, api, productBody(pt.ID, "M2"))
	a, b, c := quickVariant(t, api, p.ID, "1"), quickVariant(t, api, p.ID, "1"), quickVariant(t, api, p.ID, "1")
	foreign := quickVariant(t, api, other.ID, "1")
	path := "/api/products/" + p.ID + "/variants/order"

	resp := api.Put(path, api.Admin.Cookie, map[string]any{"ids": []string{c.ID, a.ID, b.ID}})
	if resp.Code != http.StatusOK {
		t.Fatalf("reorder: got %d: %s", resp.Code, resp.Body)
	}
	got := decode[product](t, resp)
	if ids := []string{got.Variants[0].ID, got.Variants[1].ID, got.Variants[2].ID}; !reflect.DeepEqual(ids, []string{c.ID, a.ID, b.ID}) ||
		got.Variants[0].SortOrder != 1 || got.Variants[2].SortOrder != 3 {
		t.Errorf("order: %+v", got.Variants)
	}
	for name, ids := range map[string][]string{
		"missing":   {a.ID, b.ID},
		"repeated":  {a.ID, b.ID, b.ID},
		"foreign":   {a.ID, b.ID, foreign.ID},
		"extra":     {a.ID, b.ID, c.ID, foreign.ID},
		"empty":     {},
		"duplicate": {a.ID, a.ID, b.ID, c.ID},
	} {
		assertError(t, api.Put(path, api.Admin.Cookie, map[string]any{"ids": ids}), http.StatusUnprocessableEntity, "variant.order_mismatch")
		_ = name
	}
	assertError(t, api.Put("/api/products/"+missing+"/variants/order", api.Admin.Cookie, map[string]any{"ids": []string{}}),
		http.StatusNotFound, "product.not_found")
	// An empty product reorders with an empty list.
	empty := newProduct(t, api, productBody(pt.ID, "M3"))
	if resp := api.Put("/api/products/"+empty.ID+"/variants/order", api.Admin.Cookie, map[string]any{"ids": []string{}}); resp.Code != http.StatusOK {
		t.Errorf("empty reorder: got %d", resp.Code)
	}
}

func TestAddons(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	pa := newProduct(t, api, productBody(pt.ID, "A"))
	pb := newProduct(t, api, productBody(pt.ID, "B"))
	img := uploadImage(t, api, 2)
	a1, a2 := quickVariant(t, api, pa.ID, "10"), quickVariant(t, api, pa.ID, "11")
	bb := variantBody("Frame", "4.5")
	bb["imageFileId"] = img
	b1 := newVariant(t, api, pb.ID, bb)
	path := func(v variant) string { return "/api/products/" + v.ProductID + "/variants/" + v.ID + "/addons" }

	resp := api.Put(path(a1), api.Admin.Cookie, map[string]any{"addons": []any{
		map[string]any{"addonVariantId": b1.ID, "required": true},
		map[string]any{"addonVariantId": a2.ID},
	}})
	if resp.Code != http.StatusOK {
		t.Fatalf("replace: got %d: %s", resp.Code, resp.Body)
	}
	got := decode[variant](t, resp).Addons
	want := []addon{
		{AddonVariantID: b1.ID, ProductID: pb.ID, ModelNumber: "B", ProductName: map[string]any{"en": "Dimmer B", "de": "Dimmer B"},
			VariantName: map[string]any{"en": "Frame"}, Price: "4.50", ImageFileID: img, Available: true, Required: true, SortOrder: 1},
		{AddonVariantID: a2.ID, ProductID: pa.ID, ModelNumber: "A", ProductName: map[string]any{"en": "Dimmer A", "de": "Dimmer A"},
			VariantName: a2.Name, Price: "11.00", Available: true, Required: false, SortOrder: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("add-ons: %+v\nwant %+v", got, want)
	}
	if p := getProduct(t, api, pa.ID); !reflect.DeepEqual(p.Variants[0].Addons, want) || len(p.Variants[1].Addons) != 0 {
		t.Errorf("product add-ons: %+v", p.Variants)
	}

	// Cycles are allowed (b1 → a1 while a1 → b1); a2 → a1 within the product.
	for _, v := range []variant{b1, a2} {
		if resp := api.Put(path(v), api.Admin.Cookie, map[string]any{"addons": []any{map[string]any{"addonVariantId": a1.ID}}}); resp.Code != http.StatusOK {
			t.Errorf("cycle: got %d: %s", resp.Code, resp.Body)
		}
	}

	// Self, duplicates and unknown variants are reported together; nothing changes.
	resp = api.Put(path(a1), api.Admin.Cookie, map[string]any{"addons": []any{
		map[string]any{"addonVariantId": a1.ID},
		map[string]any{"addonVariantId": b1.ID},
		map[string]any{"addonVariantId": b1.ID, "required": true},
		map[string]any{"addonVariantId": missing},
	}})
	assertFields(t, resp,
		"body.addons[0].addonVariantId addon.self",
		"body.addons[2].addonVariantId addon.duplicate",
		"body.addons[3].addonVariantId addon.variant_not_found",
	)
	if p := getProduct(t, api, pa.ID); !reflect.DeepEqual(p.Variants[0].Addons, want) {
		t.Errorf("after failed replace: %+v", p.Variants[0].Addons)
	}

	// Replace means replace: the new list in its order.
	resp = api.Put(path(a1), api.Admin.Cookie, map[string]any{"addons": []any{map[string]any{"addonVariantId": a2.ID, "required": true}}})
	if got := decode[variant](t, resp).Addons; len(got) != 1 || got[0].AddonVariantID != a2.ID || !got[0].Required || got[0].SortOrder != 1 {
		t.Errorf("replaced: %+v", got)
	}
	// Too many.
	many := make([]any, 101)
	for i := range many {
		many[i] = map[string]any{"addonVariantId": b1.ID}
	}
	assertFields(t, api.Put(path(a1), api.Admin.Cookie, map[string]any{"addons": many}), "body.addons validation.too_many")
	// Wrong product in the path, or an unknown variant.
	assertError(t, api.Put("/api/products/"+pb.ID+"/variants/"+a1.ID+"/addons", api.Admin.Cookie, map[string]any{"addons": []any{}}),
		http.StatusNotFound, "variant.not_found")

	// Deleting a variant removes its links in both directions.
	if resp := api.Put(path(a1), api.Admin.Cookie, map[string]any{"addons": []any{map[string]any{"addonVariantId": b1.ID}}}); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	if resp := api.Delete("/api/products/"+pb.ID+"/variants/"+b1.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatal(resp.Body)
	}
	if p := getProduct(t, api, pa.ID); len(p.Variants[0].Addons) != 0 || len(p.Variants[1].Addons) != 1 {
		t.Errorf("after variant delete: %+v", p.Variants)
	}
	// Deleting a product removes the links to its variants; an empty list clears.
	if resp := api.Delete("/api/products/"+pa.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatal(resp.Body)
	}
	var n int
	if err := api.DB.QueryRow(t.Context(), `SELECT count(*) FROM variant_addons`).Scan(&n); err != nil || n != 0 {
		t.Errorf("add-on links left: %d (%v)", n, err)
	}
}

func TestConcurrentAddonReplaces(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "A"))
	vs := make([]variant, 6)
	for i := range vs {
		vs[i] = quickVariant(t, api, p.ID, "1")
	}
	// Variants pointing at each other, replaced at the same time: no
	// deadlock, no duplicate links.
	var wg sync.WaitGroup
	codes := make([]int, 24)
	for i := range codes {
		wg.Go(func() {
			v := vs[i%len(vs)]
			list := []any{}
			for _, o := range vs {
				if o.ID != v.ID {
					list = append(list, map[string]any{"addonVariantId": o.ID})
				}
			}
			codes[i] = api.Put("/api/products/"+p.ID+"/variants/"+v.ID+"/addons", api.Admin.Cookie, map[string]any{"addons": list}).Code
		})
	}
	wg.Wait()
	for _, c := range codes {
		if c != http.StatusOK {
			t.Errorf("concurrent replace: %v", codes)
			break
		}
	}
	for _, v := range getProduct(t, api, p.ID).Variants {
		if len(v.Addons) != len(vs)-1 {
			t.Errorf("variant %s: %d add-ons", v.ID, len(v.Addons))
		}
	}
}

func TestAvailability(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	other := newType(t, api, "other", []any{})
	p := newProduct(t, api, dimmerBody(pt.ID, "M1"))
	v := quickVariant(t, api, p.ID, "1")
	host := newProduct(t, api, map[string]any{"productTypeId": other.ID, "modelNumber": "H", "name": text("Host"), "isActive": true})
	hv := quickVariant(t, api, host.ID, "1")
	addonPath := "/api/products/" + host.ID + "/variants/" + hv.ID + "/addons"
	if resp := api.Put(addonPath, api.Admin.Cookie, map[string]any{"addons": []any{map[string]any{"addonVariantId": v.ID}}}); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}

	check := func(step string, wantProduct, wantVariant, listed bool) {
		t.Helper()
		got := getProduct(t, api, p.ID)
		if got.Available != wantProduct || got.Variants[0].Available != wantVariant {
			t.Errorf("%s: product available %v, variant available %v", step, got.Available, got.Variants[0].Available)
		}
		if a := getProduct(t, api, host.ID).Variants[0].Addons[0]; a.Available != wantVariant {
			t.Errorf("%s: add-on available %v", step, a.Available)
		}
		hits := decode[variantPage](t, api.Get("/api/variants?search=M1", api.Admin.Cookie))
		if len(hits.Items) != 1 || hits.Items[0].Available != wantVariant {
			t.Errorf("%s: variant search %+v", step, hits.Items)
		}
		if got := models(list(t, api, api.Admin.Cookie, "")); slicesContains(got, "M1") != listed {
			t.Errorf("%s: default list %v", step, got)
		}
		all := list(t, api, api.Admin.Cookie, "?includeInactive=true")
		for _, it := range all.Items {
			if it.ID == p.ID && it.Available != wantProduct {
				t.Errorf("%s: list item available %v", step, it.Available)
			}
		}
		if len(all.Items) != 2 {
			t.Errorf("%s: includeInactive lists %v", step, models(all))
		}
	}
	check("all active", true, true, true)

	// The variant's own flag.
	cur := getProduct(t, api, p.ID).Variants[0]
	b := variantBody(cur.Name["en"].(string), "1")
	b["isActive"] = false
	if resp := updateVariant(api, cur, b); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	check("variant inactive", true, false, true)
	cur = getProduct(t, api, p.ID).Variants[0]
	b["isActive"] = true
	if resp := updateVariant(api, cur, b); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}

	// The product: deactivating writes nothing to its variants.
	pb := dimmerBody(pt.ID, "M1")
	pb["isActive"] = false
	if resp := update(api, getProduct(t, api, p.ID), pb); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	check("product inactive", false, false, false)
	if got := getProduct(t, api, p.ID); !got.Variants[0].IsActive || got.IsActive {
		t.Errorf("flags after product deactivation: %+v", got)
	}
	pb["isActive"] = true
	if resp := update(api, getProduct(t, api, p.ID), pb); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	check("product reactivated", true, true, true)

	// The type.
	updateType(t, api, pt, schema(), false)
	check("type inactive", false, false, false)
	if got := getProduct(t, api, p.ID); !got.IsActive || !got.Variants[0].IsActive || got.ProductType.IsActive {
		t.Errorf("flags after type deactivation: %+v", got)
	}
	updateType(t, api, pt, schema(), true)
	check("type reactivated", true, true, true)

	// A variant deactivated on its own stays inactive through a type cycle.
	cur = getProduct(t, api, p.ID).Variants[0]
	b["isActive"] = false
	if resp := updateVariant(api, cur, b); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	updateType(t, api, pt, schema(), false)
	updateType(t, api, pt, schema(), true)
	check("variant inactive after type cycle", true, false, true)
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestSchemaChange(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	b := dimmerBody(pt.ID, "M1")
	b["attributes"] = map[string]any{"width_te": 12, "bus_system": "zigbee"}
	p := newProduct(t, api, b)
	vb := variantBody("Ivory", "1")
	vb["attributes"] = map[string]any{"colour": "ivory", "finish": "matt"}
	v := newVariant(t, api, p.ID, vb)

	// width_te now at most 10, bus_system and finish removed, colour required.
	changed := schema()
	changed[0].(map[string]any)["max"] = 10
	changed[2].(map[string]any)["required"] = true
	updateType(t, api, pt, []any{changed[0], changed[2]}, true)

	got := getProduct(t, api, p.ID)
	if !reflect.DeepEqual(got.Attributes, map[string]any{"width_te": 12.0}) ||
		!reflect.DeepEqual(got.StaleAttributes, map[string]any{"bus_system": "zigbee"}) ||
		!reflect.DeepEqual(errorLocations(got.AttributeErrors), []string{"attributes.width_te attribute.range"}) {
		t.Errorf("product: %v stale %v errors %v", got.Attributes, got.StaleAttributes, got.AttributeErrors)
	}
	if e := got.AttributeErrors[0]; e.Params["min"] != 1.0 || e.Params["max"] != 10.0 {
		t.Errorf("params: %v", e.Params)
	}
	gv := got.Variants[0]
	if !reflect.DeepEqual(gv.Attributes, map[string]any{"colour": "ivory"}) ||
		!reflect.DeepEqual(gv.StaleAttributes, map[string]any{"finish": "matt"}) || len(gv.AttributeErrors) != 0 {
		t.Errorf("variant: %v stale %v errors %v", gv.Attributes, gv.StaleAttributes, gv.AttributeErrors)
	}
	items := list(t, api, api.Admin.Cookie, "").Items
	if items[0].AttributeErrors != 1 || items[0].StaleAttributes != 2 {
		t.Errorf("list counts: %+v", items[0])
	}

	// Saving: the stale value is kept untouched when sent back (even if the
	// client changed it), removed when left out; new unknown keys fail.
	ub := dimmerBody(pt.ID, "M1")
	ub["attributes"] = map[string]any{"width_te": 8, "bus_system": "knx"}
	resp := update(api, got, ub)
	if resp.Code != http.StatusOK {
		t.Fatalf("save with stale: got %d: %s", resp.Code, resp.Body)
	}
	saved := decode[product](t, resp)
	if !reflect.DeepEqual(saved.StaleAttributes, map[string]any{"bus_system": "zigbee"}) || len(saved.AttributeErrors) != 0 {
		t.Errorf("after save: stale %v errors %v", saved.StaleAttributes, saved.AttributeErrors)
	}
	ub["attributes"] = map[string]any{"width_te": 8, "foo": 1}
	assertFields(t, update(api, saved, ub), "body.attributes.foo attribute.unknown")
	ub["attributes"] = map[string]any{"width_te": 8}
	resp = update(api, saved, ub)
	if removed := decode[product](t, resp); resp.Code != http.StatusOK || len(removed.StaleAttributes) != 0 {
		t.Errorf("remove stale: got %d: %+v", resp.Code, removed.StaleAttributes)
	}
	if items := list(t, api, api.Admin.Cookie, "").Items; items[0].AttributeErrors != 0 || items[0].StaleAttributes != 1 {
		t.Errorf("list counts after save: %+v", items[0])
	}

	// The variant: colour is now required; finish is kept when sent back.
	vu := variantBody("Ivory", "1")
	vu["attributes"] = map[string]any{"finish": "matt"}
	assertFields(t, updateVariant(api, gv, vu), "body.attributes.colour attribute.required")
	vu["attributes"] = map[string]any{"finish": "matt", "colour": "white"}
	resp = updateVariant(api, gv, vu)
	if sv := decode[variant](t, resp); resp.Code != http.StatusOK || !reflect.DeepEqual(sv.StaleAttributes, map[string]any{"finish": "matt"}) {
		t.Errorf("variant save: got %d: %s", resp.Code, resp.Body)
	}
	_ = v

	// Changing the type re-validates the values: unknown ones become stale.
	plain := newType(t, api, "plain", []any{
		map[string]any{"key": "voltage", "label": text("V"), "type": "number", "required": true},
	})
	cur := getProduct(t, api, p.ID)
	tb := productBody(plain.ID, "M1")
	tb["attributes"] = map[string]any{"width_te": 8}
	assertFields(t, update(api, cur, tb), "body.attributes.voltage attribute.required")
	tb["attributes"] = map[string]any{"width_te": 8, "voltage": 230}
	resp = update(api, cur, tb)
	moved := decode[product](t, resp)
	if resp.Code != http.StatusOK || !reflect.DeepEqual(moved.Attributes, map[string]any{"voltage": 230.0}) ||
		!reflect.DeepEqual(moved.StaleAttributes, map[string]any{"width_te": 8.0}) || moved.ProductType.Key != "plain" {
		t.Errorf("type change: got %d: %+v", resp.Code, moved)
	}
	if mv := moved.Variants[0]; !reflect.DeepEqual(mv.StaleAttributes, map[string]any{"colour": "white", "finish": "matt"}) {
		t.Errorf("variant after type change: %+v", mv)
	}
}

func TestListAggregates(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))
	newProduct(t, api, productBody(pt.ID, "M0"))
	imgA, imgB := uploadImage(t, api, 3), uploadImage(t, api, 4)

	inactive := variantBody("Cheap", "0.50")
	inactive["isActive"] = false
	inactive["imageFileId"] = imgA
	newVariant(t, api, p.ID, inactive)
	newVariant(t, api, p.ID, variantBody("No image", "27"))
	withImage := variantBody("Image", "100.10")
	withImage["imageFileId"] = imgB
	newVariant(t, api, p.ID, withImage)
	newVariant(t, api, p.ID, variantBody("Mid", "9.9"))

	items := list(t, api, api.Admin.Cookie, "").Items
	if len(items) != 2 || items[0].ModelNumber != "M0" {
		t.Fatalf("items: %+v", items)
	}
	empty, it := items[0], items[1]
	if empty.VariantCount != 0 || empty.PriceMin != "" || empty.PreviewImageFileID != "" {
		t.Errorf("empty product: %+v", empty)
	}
	if it.VariantCount != 4 || it.PriceMin != "9.90" || it.PriceMax != "100.10" || it.PreviewImageFileID != imgB ||
		!it.Available || it.ProductType.Key != "free" || it.ProductType.Color != "#1f6feb" || !it.Can.Update {
		t.Errorf("aggregates: %+v", it)
	}
}

func TestSearchAndPagination(t *testing.T) {
	api := apptest.New(t)
	b := newType(t, api, "b_type", []any{})
	a := newType(t, api, "a_type", []any{})
	// Catalog order: b_type first (created first), then a_type.
	for _, m := range []string{"AB%1", "AB_2", "ABx2", "zz-9", "Mm-1"} {
		newProduct(t, api, productBody(a.ID, m))
	}
	named := productBody(b.ID, "Q-1")
	named["name"] = map[string]string{"en": "Gateway", "de": "Schnittstelle"}
	q := newProduct(t, api, named)
	vb := variantBody("Weiß", "1")
	vb["sku"] = "SKU-Ivory_77"
	newVariant(t, api, q.ID, vb)

	if got := models(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"Q-1", "AB%1", "AB_2", "ABx2", "Mm-1", "zz-9"}) {
		t.Errorf("order: %v", got)
	}
	for search, want := range map[string][]string{
		"%":             {"AB%1"},
		"_":             {"Q-1", "AB_2"}, // Q-1's SKU has an underscore
		"ab":            {"AB%1", "AB_2", "ABx2"},
		"b%":            {"AB%1"},
		`\`:             {},
		"schnitt":       {"Q-1"},
		"GATEWAY":       {"Q-1"},
		"ivory_7":       {"Q-1"},
		"ivory%7":       {},
		"  zz  ":        {"zz-9"},
		"nothing-there": {},
	} {
		got := list(t, api, api.Admin.Cookie, "?search="+urlEncode(search))
		if !reflect.DeepEqual(models(got), want) || got.Total != len(want) {
			t.Errorf("search %q: %v (total %d)", search, models(got), got.Total)
		}
	}
	if got := models(list(t, api, api.Admin.Cookie, "?productTypeId="+b.ID)); !reflect.DeepEqual(got, []string{"Q-1"}) {
		t.Errorf("type filter: %v", got)
	}

	// Pages.
	p1 := list(t, api, api.Admin.Cookie, "?limit=2")
	p3 := list(t, api, api.Admin.Cookie, "?limit=2&offset=4")
	beyond := list(t, api, api.Admin.Cookie, "?limit=2&offset=10")
	if !reflect.DeepEqual(models(p1), []string{"Q-1", "AB%1"}) || p1.Total != 6 ||
		!reflect.DeepEqual(models(p3), []string{"Mm-1", "zz-9"}) || len(beyond.Items) != 0 || beyond.Total != 6 {
		t.Errorf("pages: %v %v %v", models(p1), models(p3), models(beyond))
	}
	if got := list(t, api, api.Admin.Cookie, "?limit=200"); len(got.Items) != 6 {
		t.Errorf("limit 200: %d", len(got.Items))
	}
	for _, query := range []string{"?limit=0", "?limit=201", "?limit=-1", "?offset=-1", "?limit=x", "?productTypeId=nope"} {
		if resp := api.Get("/api/products"+query, api.Admin.Cookie); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: got %d", query, resp.Code)
		}
		if strings.Contains(query, "limit") || strings.Contains(query, "offset") {
			if resp := api.Get("/api/variants"+query, api.Admin.Cookie); resp.Code != http.StatusUnprocessableEntity {
				t.Errorf("variants %s: got %d", query, resp.Code)
			}
		}
	}
	if resp := api.Get("/api/products?search="+strings.Repeat("x", 201), api.Admin.Cookie); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("long search: got %d", resp.Code)
	}

	// Variant search: names, SKUs and model numbers, escaped, in catalog order.
	for _, m := range []string{"AB%1", "AB_2"} {
		var id string
		for _, it := range list(t, api, api.Admin.Cookie, "?search="+urlEncode(m)).Items {
			id = it.ID
		}
		newVariant(t, api, id, variantBody("Black "+m, "2"))
	}
	for search, want := range map[string][]string{
		"weiß":    {"Q-1"},
		"ivory_7": {"Q-1"},
		"%":       {"AB%1"},
		"_":       {"Q-1", "AB_2"},
		"black":   {"AB%1", "AB_2"},
		"":        {"Q-1", "AB%1", "AB_2"},
	} {
		got := decode[variantPage](t, api.Get("/api/variants?search="+urlEncode(search), api.Admin.Cookie))
		gotModels := []string{}
		for _, h := range got.Items {
			gotModels = append(gotModels, h.ModelNumber)
		}
		if !reflect.DeepEqual(gotModels, want) || got.Total != len(want) {
			t.Errorf("variant search %q: %v (total %d)", search, gotModels, got.Total)
		}
	}
	hit := decode[variantPage](t, api.Get("/api/variants?search=weiß", api.Admin.Cookie)).Items[0]
	if hit.ProductID != q.ID || hit.SKU != "SKU-Ivory_77" || hit.Price != "1.00" || !hit.Available ||
		hit.ProductName["en"] != "Gateway" || hit.Name["en"] != "Weiß" || hit.ProductTypeID != b.ID {
		t.Errorf("hit: %+v", hit)
	}
	if got := decode[variantPage](t, api.Get("/api/variants?limit=1&offset=1", api.Admin.Cookie)); len(got.Items) != 1 || got.Total != 3 || got.Items[0].ModelNumber != "AB%1" {
		t.Errorf("variant page: %+v", got)
	}
}

func urlEncode(s string) string { return url.QueryEscape(s) }

func TestNotFound(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))
	stamp := time.Now().Format(time.RFC3339)
	vpath := "/api/products/" + p.ID + "/variants/" + missing
	for name, tc := range map[string]struct {
		resp *httptest.ResponseRecorder
		code string
	}{
		"get":            {api.Get("/api/products/"+missing, api.Admin.Cookie), "product.not_found"},
		"update":         {update(api, product{ID: missing, UpdatedAt: stamp}, productBody(pt.ID, "X")), "product.not_found"},
		"delete":         {api.Delete("/api/products/"+missing, api.Admin.Cookie), "product.not_found"},
		"update variant": {api.Put(vpath, api.Admin.Cookie, map[string]any{"name": text("x"), "price": "1", "isActive": true, "expectedUpdatedAt": stamp}), "variant.not_found"},
		"delete variant": {api.Delete(vpath, api.Admin.Cookie), "variant.not_found"},
		"add-ons":        {api.Put(vpath+"/addons", api.Admin.Cookie, map[string]any{"addons": []any{}}), "variant.not_found"},
	} {
		if tc.resp.Code != http.StatusNotFound || decode[problem](t, tc.resp).Code != tc.code {
			t.Errorf("%s: got %d: %s", name, tc.resp.Code, tc.resp.Body)
		}
	}
}

func TestDeleteProductCascades(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt.ID, "M1"))
	img := uploadImage(t, api, 5)
	vb := variantBody("a", "1")
	vb["imageFileId"] = img
	newVariant(t, api, p.ID, vb)
	quickVariant(t, api, p.ID, "1")
	if resp := api.Delete("/api/products/"+p.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Fatal(resp.Body)
	}
	var n int
	if err := api.DB.QueryRow(t.Context(), `SELECT count(*) FROM product_variants`).Scan(&n); err != nil || n != 0 {
		t.Errorf("variants left: %d (%v)", n, err)
	}
	// Unreferenced files are kept (cleanup comes later).
	if resp := api.Get("/api/files/"+img, api.Admin.Cookie); resp.Code != http.StatusOK {
		t.Errorf("image after delete: got %d", resp.Code)
	}
	// The type is free to delete now.
	if resp := api.Delete("/api/product-types/"+pt.ID, api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Errorf("delete type: got %d: %s", resp.Code, resp.Body)
	}
}
