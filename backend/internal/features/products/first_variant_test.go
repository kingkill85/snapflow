package products_test

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
)

// D449: the product and its first variant are created in one transaction.
func TestCreateWithFirstVariant(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())

	// Without firstVariant: no variants, as before (the import and the API
	// clients that add variants themselves).
	if p := newProduct(t, api, dimmerBody(pt, "M0")); len(p.Variants) != 0 {
		t.Errorf("without firstVariant: %+v", p.Variants)
	}

	b := dimmerBody(pt, "M1")
	b["firstVariant"] = map[string]any{"sku": " M1-STD ", "price": "27", "attributes": map[string]any{"colour": " ivory ", "finish": "matt"}}
	p := newProduct(t, api, b)
	if len(p.Variants) != 1 {
		t.Fatalf("variants: %+v", p.Variants)
	}
	v := p.Variants[0]
	if v.SKU != "M1-STD" || v.Price != "27.00" || !v.IsActive || v.SortOrder != 1 ||
		!reflect.DeepEqual(v.Name, map[string]any{"en": "Standard", "de": "Standard"}) ||
		!reflect.DeepEqual(v.Attributes, map[string]any{"colour": "ivory", "finish": "matt"}) {
		t.Errorf("first variant: %+v", v)
	}

	b = dimmerBody(pt, "M2")
	b["firstVariant"] = map[string]any{"name": map[string]string{"en": " White ", "de": "Weiß"}, "price": "0"}
	if v := newProduct(t, api, b).Variants[0]; !reflect.DeepEqual(v.Name, map[string]any{"en": "White", "de": "Weiß"}) || v.SKU != "" || v.Price != "0.00" {
		t.Errorf("named first variant: %+v", v)
	}
}

func TestFirstVariantValidation(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())

	b := dimmerBody(pt, "M1")
	b["firstVariant"] = map[string]any{"name": map[string]string{"de": "Nur deutsch"}, "sku": "A\tB", "price": "1.234"}
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, b),
		"body.firstVariant.name.en validation.required",
		"body.firstVariant.sku validation.control_chars",
		"body.firstVariant.price variant.price_format")

	// Product and variant errors in one round.
	b = dimmerBody(pt, "")
	b["firstVariant"] = map[string]any{"price": "x"}
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, b),
		"body.modelNumber validation.required",
		"body.firstVariant.price variant.price_format")

	// A required variant attribute of the category is checked on the first variant.
	required := append(schema(), map[string]any{"key": "voltage", "label": text("Voltage"), "type": "integer", "scope": "variant", "required": true})
	rt := newType(t, api, "relay", required)
	b = dimmerBody(rt, "R1")
	b["firstVariant"] = map[string]any{"price": "1"}
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, b), "body.firstVariant.attributes.voltage attribute.required")
	b["firstVariant"] = map[string]any{"price": "1", "attributes": map[string]any{"voltage": 230}}
	if v := newProduct(t, api, b).Variants[0]; !reflect.DeepEqual(v.Attributes, map[string]any{"voltage": float64(230)}) {
		t.Errorf("variant attributes: %+v", v.Attributes)
	}

	if got := models(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"R1"}) {
		t.Errorf("refused creates left products: %v", got)
	}
}

// A refused variant (a taken SKU, found only by the database) leaves no product.
func TestFirstVariantTransaction(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "dimmer", schema())
	other := newProduct(t, api, dimmerBody(pt, "OTHER"))
	newVariant(t, api, other.ID, map[string]any{"name": text("Std"), "sku": "TAKEN", "price": "1", "isActive": true})

	b := dimmerBody(pt, "M1")
	b["firstVariant"] = map[string]any{"sku": "taken", "price": "1"}
	assertError(t, api.Post("/api/products", api.Admin.Cookie, b), http.StatusConflict, "variant.sku_taken")
	if got := models(list(t, api, api.Admin.Cookie, "")); !reflect.DeepEqual(got, []string{"OTHER"}) {
		t.Errorf("products after the refused create: %v", got)
	}
	// The model number is free again.
	b["firstVariant"] = map[string]any{"sku": "FREE", "price": "1"}
	newProduct(t, api, b)
}
