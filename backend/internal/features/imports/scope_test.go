package imports_test

import (
	"net/http"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
)

// csvMapping maps Model, Name, Variant and Price columns with a fixed
// product type and category, plus extra fields.
func csvMapping(typeID, catID string, extra ...map[string]any) map[string]any {
	fields := []any{
		map[string]any{"target": "product.modelNumber", "column": "Model"},
		map[string]any{"target": "product.name.en", "column": "Name"},
		map[string]any{"target": "variant.name.en", "column": "Variant"},
		map[string]any{"target": "variant.price", "column": "Price"},
	}
	for _, e := range extra {
		fields = append(fields, e)
	}
	m := map[string]any{"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "fields": fields}
	if typeID != "" {
		m["productTypeId"] = typeID
	}
	if catID != "" {
		m["categoryId"] = catID
	}
	return m
}

var (
	skuField   = map[string]any{"target": "variant.sku", "column": "SKU"}
	addonField = map[string]any{"target": "addon.required", "column": "Addon"}
)

// newVariant adds a variant by hand.
func newVariant(t *testing.T, api *apptest.API, productID, name, sku string) variant {
	t.Helper()
	body := map[string]any{"name": map[string]string{"en": name}, "price": "1", "isActive": true}
	if sku != "" {
		body["sku"] = sku
	}
	resp := api.Post("/api/products/"+productID+"/variants", api.Admin.Cookie, body)
	expect(t, resp, http.StatusCreated)
	return decode[variant](t, resp)
}

// editVariant sets a variant's price and SKU.
func editVariant(t *testing.T, api *apptest.API, productID string, v variant, price, sku string) {
	t.Helper()
	body := map[string]any{"name": v.Name, "price": price, "isActive": true, "expectedUpdatedAt": v.UpdatedAt}
	if sku != "" {
		body["sku"] = sku
	}
	expect(t, api.Put("/api/products/"+productID+"/variants/"+v.ID, api.Admin.Cookie, body), http.StatusOK)
}

// renameProduct sets a product's English name.
func renameProduct(t *testing.T, api *apptest.API, p product, name string) {
	t.Helper()
	expect(t, api.Put("/api/products/"+p.ID, api.Admin.Cookie, map[string]any{
		"productTypeId": p.ProductTypeID, "categoryId": p.CategoryID, "modelNumber": p.ModelNumber, "name": map[string]string{"en": name},
		"attributes": p.Attributes, "isActive": p.IsActive, "expectedUpdatedAt": p.UpdatedAt,
	}), http.StatusOK)
}

func setAddons(t *testing.T, api *apptest.API, productID, variantID string, addonIDs ...string) {
	t.Helper()
	list := []any{}
	for _, id := range addonIDs {
		list = append(list, map[string]any{"addonVariantId": id})
	}
	expect(t, api.Put("/api/products/"+productID+"/variants/"+variantID+"/addons", api.Admin.Cookie, map[string]any{"addons": list}), http.StatusOK)
}

// The catalog token covers only what the preview read (D147): edits of
// other systems and categories leave a preview applicable; every kind of
// entity the preview read makes it stale.
func TestStaleScope(t *testing.T) {
	api := apptest.New(t)
	knx := newProductType(t, api, "knx", "KNX")
	zb := newProductType(t, api, "zb", "ZB")
	dimmer := newCategory(t, api, "dimmer", "", nil)
	other := newCategory(t, api, "other", "", nil)
	// E-1 is in the file, G-1 in the scope pair (to deactivate), A-1 an
	// add-on target, X-1 unrelated.
	e1 := newProduct(t, api, knx.ID, dimmer.ID, "E-1")
	newVariant(t, api, e1.ID, "Standard", "E1")
	newProduct(t, api, knx.ID, dimmer.ID, "G-1")
	a1 := newProduct(t, api, zb.ID, other.ID, "A-1")
	newVariant(t, api, a1.ID, "Standard", "A1")
	x1 := newProduct(t, api, zb.ID, other.ID, "X-1")
	xv := newVariant(t, api, x1.ID, "Standard", "X1")

	m := csvMapping(knx.ID, dimmer.ID, skuField, addonField)
	run := upload(t, api, "d.csv", csvFile("Model;Name;Variant;SKU;Price;Addon", "D-1;Dimmer;;D1;5;A1", "E-1;E-1;;E1;1;"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Errors != 0 || run.Counts.Products.Deactivate != 1 || run.Counts.Addons.New != 1 {
		t.Fatalf("counts %+v", run.Counts)
	}
	id := run.ID.String()
	stale := func(what string, change func()) {
		t.Helper()
		change()
		resp := api.Post("/api/imports/"+id+"/apply", api.Admin.Cookie, map[string]any{})
		if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "import.stale" {
			t.Fatalf("%s: got %d %s, want import.stale", what, resp.Code, resp.Body)
		}
		preview(t, api, id, map[string]any{"mapping": m})
	}
	cat := func() map[string]product { return catalog(t, api) }

	stale("the fixed product type", func() {
		expect(t, api.Put("/api/product-types/"+knx.ID, api.Admin.Cookie, map[string]any{"key": "knx", "name": map[string]string{"en": "KNX"},
			"isActive": true, "expectedUpdatedAt": knx.UpdatedAt}), http.StatusOK)
	})
	stale("the fixed category", func() {
		expect(t, api.Put("/api/categories/"+dimmer.ID, api.Admin.Cookie, map[string]any{"key": "dimmer", "name": map[string]string{"en": "Dimmers"},
			"isActive": true, "attributes": []any{}, "instanceAttributes": []any{}, "expectedUpdatedAt": dimmer.UpdatedAt}), http.StatusOK)
	})
	stale("a matched product", func() { renameProduct(t, api, cat()["E-1"], "Edited") })
	stale("a product to deactivate", func() { renameProduct(t, api, cat()["G-1"], "Edited") })
	stale("a new product in the scope pair", func() { newProduct(t, api, knx.ID, dimmer.ID, "NEW-1") })
	stale("a product created with a model number of the file", func() { newProduct(t, api, zb.ID, other.ID, "d-1") })
	expect(t, api.Delete("/api/products/"+cat()["d-1"].ID, api.Admin.Cookie), http.StatusNoContent)
	preview(t, api, id, map[string]any{"mapping": m})
	stale("a variant of a matched product", func() {
		p := cat()["E-1"]
		editVariant(t, api, p.ID, p.Variants[0], "2", "E1")
	})
	stale("the add-on list of a matched variant", func() {
		p := cat()["E-1"]
		setAddons(t, api, p.ID, p.Variants[0].ID, xv.ID)
	})
	stale("a variant taking an SKU of the file", func() { editVariant(t, api, x1.ID, cat()["X-1"].Variants[0], "1", "D1") })
	editVariant(t, api, x1.ID, cat()["X-1"].Variants[0], "1", "X1")
	preview(t, api, id, map[string]any{"mapping": m})
	stale("an add-on target", func() {
		p := cat()["A-1"]
		editVariant(t, api, p.ID, p.Variants[0], "3", "A1")
	})
	stale("an add-on target's product", func() { renameProduct(t, api, cat()["A-1"], "Renamed") })
	stale("a variant a reference would find by model number", func() {
		p := newProduct(t, api, zb.ID, other.ID, "A1")
		newVariant(t, api, p.ID, "Standard", "")
	})

	// Edits elsewhere: another system's or category's products, their
	// add-on lists, the target's category and system, a new unrelated
	// category and product type.
	newProduct(t, api, zb.ID, other.ID, "UNRELATED-1")
	expect(t, api.Put("/api/product-types/"+zb.ID, api.Admin.Cookie, map[string]any{"key": "zb", "name": map[string]string{"en": "Zigbee"},
		"isActive": true, "expectedUpdatedAt": zb.UpdatedAt}), http.StatusOK)
	newProductType(t, api, "enocean", "EO")
	renameProduct(t, api, cat()["X-1"], "Edited")
	setAddons(t, api, x1.ID, xv.ID, cat()["A-1"].Variants[0].ID)
	newCategory(t, api, "unrelated", "", nil)
	o := categoryList(t, api)["other"]
	expect(t, api.Put("/api/categories/"+o.ID, api.Admin.Cookie, map[string]any{"key": "other", "name": map[string]string{"en": "Others"},
		"isActive": true, "attributes": []any{}, "instanceAttributes": []any{}, "expectedUpdatedAt": o.UpdatedAt}), http.StatusOK)
	newProduct(t, api, knx.ID, other.ID, "OTHER-PAIR")
	if applied := apply(t, api, id, nil); applied.State != imports.StateApplied {
		t.Fatalf("applied %+v", applied)
	}
}

// Category and product type values from columns: a category or type
// created since that matches a value makes the preview stale (it could
// resolve differently; the run would create the category too). Others do
// not.
func TestStaleValues(t *testing.T) {
	api := apptest.New(t)
	newProductType(t, api, "knx", "KNX")
	m := csvMapping("", "", map[string]any{"target": "product.category", "column": "Category"}, map[string]any{"target": "product.productType", "column": "System"})
	m["createMissingCategories"] = true
	run := upload(t, api, "d.csv", csvFile("Model;Name;Variant;Price;Category;System", "D-1;Dimmer;;5;Smart Frames;knx"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Categories.New != 1 || run.Counts.Errors != 0 {
		t.Fatalf("counts %+v", run.Counts)
	}
	newCategory(t, api, "unrelated", "", nil)
	newProductType(t, api, "zb", "ZB")
	newProductType(t, api, "knx_ip", "KNX")
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	newCategory(t, api, "smart_frames", "Frames", nil)
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Categories.New != 0 {
		t.Errorf("the created category is used now: %+v", run.Counts.Categories)
	}
	apply(t, api, run.ID.String(), nil)
}
