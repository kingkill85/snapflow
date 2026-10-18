package products_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

type fieldError struct {
	Location string         `json:"location"`
	Code     string         `json:"code"`
	Params   map[string]any `json:"params"`
}

type problem struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params"`
	Fields []fieldError   `json:"fields"`
}

type typeRef struct {
	ID       string         `json:"id"`
	Key      string         `json:"key"`
	Name     map[string]any `json:"name"`
	Color    string         `json:"color"`
	IsActive bool           `json:"isActive"`
}

type addon struct {
	AddonVariantID string         `json:"addonVariantId"`
	ProductID      string         `json:"productId"`
	ModelNumber    string         `json:"modelNumber"`
	ProductName    map[string]any `json:"productName"`
	VariantName    map[string]any `json:"variantName"`
	Price          string         `json:"price"`
	ImageFileID    string         `json:"imageFileId"`
	Available      bool           `json:"available"`
	Required       bool           `json:"required"`
	SortOrder      int            `json:"sortOrder"`
}

type variant struct {
	ID              string         `json:"id"`
	ProductID       string         `json:"productId"`
	Name            map[string]any `json:"name"`
	SKU             string         `json:"sku"`
	Price           string         `json:"price"`
	ImageFileID     string         `json:"imageFileId"`
	Attributes      map[string]any `json:"attributes"`
	StaleAttributes map[string]any `json:"staleAttributes"`
	AttributeErrors []fieldError   `json:"attributeErrors"`
	SortOrder       int            `json:"sortOrder"`
	IsActive        bool           `json:"isActive"`
	Available       bool           `json:"available"`
	Addons          []addon        `json:"addons"`
	UpdatedAt       string         `json:"updatedAt"`
	Can             auth.Actions   `json:"can"`
}

type product struct {
	ID              string         `json:"id"`
	ProductTypeID   string         `json:"productTypeId"`
	ProductType     typeRef        `json:"productType"`
	ModelNumber     string         `json:"modelNumber"`
	Name            map[string]any `json:"name"`
	Description     map[string]any `json:"description"`
	Attributes      map[string]any `json:"attributes"`
	StaleAttributes map[string]any `json:"staleAttributes"`
	AttributeErrors []fieldError   `json:"attributeErrors"`
	IsActive        bool           `json:"isActive"`
	Available       bool           `json:"available"`
	Variants        []variant      `json:"variants"`
	// VariantsWithProblems counts variants with attribute errors or stale values.
	VariantsWithProblems int          `json:"variantsWithProblems"`
	UpdatedAt            string       `json:"updatedAt"`
	Can                  auth.Actions `json:"can"`
}

type listItem struct {
	ID                 string       `json:"id"`
	ProductTypeID      string       `json:"productTypeId"`
	ProductType        typeRef      `json:"productType"`
	ModelNumber        string       `json:"modelNumber"`
	IsActive           bool         `json:"isActive"`
	Available          bool         `json:"available"`
	VariantCount       int          `json:"variantCount"`
	PriceMin           string       `json:"priceMin"`
	PriceMax           string       `json:"priceMax"`
	PreviewImageFileID string       `json:"previewImageFileId"`
	AttributeErrors    int          `json:"attributeErrors"`
	StaleAttributes    int          `json:"staleAttributes"`
	Can                auth.Actions `json:"can"`
}

type page struct {
	Items []listItem `json:"items"`
	Total int        `json:"total"`
}

type variantHit struct {
	ID            string         `json:"id"`
	ProductID     string         `json:"productId"`
	ProductTypeID string         `json:"productTypeId"`
	ModelNumber   string         `json:"modelNumber"`
	ProductName   map[string]any `json:"productName"`
	Name          map[string]any `json:"name"`
	SKU           string         `json:"sku"`
	Price         string         `json:"price"`
	ImageFileID   string         `json:"imageFileId"`
	Available     bool           `json:"available"`
}

type variantPage struct {
	Items []variantHit `json:"items"`
	Total int          `json:"total"`
}

type productType struct {
	ID         string           `json:"id"`
	Key        string           `json:"key"`
	Attributes []map[string]any `json:"attributes"`
	IsActive   bool             `json:"isActive"`
	UpdatedAt  string           `json:"updatedAt"`
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func text(en string) map[string]string { return map[string]string{"en": en} }

// schema is the attribute schema of the test type "dimmer".
func schema() []any {
	return []any{
		map[string]any{"key": "width_te", "label": text("Width"), "type": "integer", "required": true, "min": 1, "max": 24},
		map[string]any{"key": "bus_system", "label": text("Bus"), "type": "enum", "options": []any{
			map[string]any{"key": "zigbee", "label": text("Zigbee")},
			map[string]any{"key": "knx", "label": text("KNX")},
		}},
		map[string]any{"key": "colour", "label": text("Colour"), "type": "text", "scope": "variant"},
		map[string]any{"key": "finish", "label": text("Finish"), "type": "enum", "scope": "variant", "options": []any{
			map[string]any{"key": "matt", "label": text("Matt")},
			map[string]any{"key": "gloss", "label": text("Gloss")},
		}},
	}
}

func typeBody(key string, attributes []any) map[string]any {
	return map[string]any{
		"key": key, "name": text(key), "color": "#1f6feb", "isActive": true,
		"attributes": attributes, "instanceAttributes": []any{},
	}
}

func newType(t *testing.T, api *apptest.API, key string, attributes []any) productType {
	t.Helper()
	resp := api.Post("/api/product-types", api.Admin.Cookie, typeBody(key, attributes))
	if resp.Code != http.StatusCreated {
		t.Fatalf("create type: got %d: %s", resp.Code, resp.Body)
	}
	return decode[productType](t, resp)
}

// updateType replaces a type's schema and active flag.
func updateType(t *testing.T, api *apptest.API, pt productType, attributes []any, active bool) productType {
	t.Helper()
	current := decode[productType](t, api.Get("/api/product-types/"+pt.ID, api.Admin.Cookie))
	b := typeBody(pt.Key, attributes)
	b["isActive"] = active
	b["expectedUpdatedAt"] = current.UpdatedAt
	resp := api.Put("/api/product-types/"+pt.ID, api.Admin.Cookie, b)
	if resp.Code != http.StatusOK {
		t.Fatalf("update type: got %d: %s", resp.Code, resp.Body)
	}
	return decode[productType](t, resp)
}

func productBody(typeID, model string) map[string]any {
	return map[string]any{
		"productTypeId": typeID, "modelNumber": model,
		"name":     map[string]string{"en": "Dimmer " + model, "de": "Dimmer " + model},
		"isActive": true,
	}
}

// dimmerBody is productBody with valid values for schema().
func dimmerBody(typeID, model string) map[string]any {
	b := productBody(typeID, model)
	b["attributes"] = map[string]any{"width_te": 4, "bus_system": "zigbee"}
	return b
}

func newProduct(t *testing.T, api *apptest.API, b map[string]any) product {
	t.Helper()
	resp := api.Post("/api/products", api.Admin.Cookie, b)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create product: got %d: %s", resp.Code, resp.Body)
	}
	return decode[product](t, resp)
}

// update sends b as an update of p (expectedUpdatedAt from p).
func update(api *apptest.API, p product, b map[string]any) *httptest.ResponseRecorder {
	b["expectedUpdatedAt"] = p.UpdatedAt
	return api.Put("/api/products/"+p.ID, api.Admin.Cookie, b)
}

func getProduct(t *testing.T, api *apptest.API, id string) product {
	t.Helper()
	resp := api.Get("/api/products/"+id, api.Admin.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("get product: got %d: %s", resp.Code, resp.Body)
	}
	return decode[product](t, resp)
}

var variantSeq atomic.Int64

func variantBody(name, price string) map[string]any {
	return map[string]any{"name": text(name), "price": price, "isActive": true}
}

func newVariant(t *testing.T, api *apptest.API, productID string, b map[string]any) variant {
	t.Helper()
	resp := api.Post("/api/products/"+productID+"/variants", api.Admin.Cookie, b)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create variant: got %d: %s", resp.Code, resp.Body)
	}
	return decode[variant](t, resp)
}

// quickVariant adds a variant with a unique name.
func quickVariant(t *testing.T, api *apptest.API, productID, price string) variant {
	t.Helper()
	return newVariant(t, api, productID, variantBody(fmt.Sprintf("Style %d", variantSeq.Add(1)), price))
}

func updateVariant(api *apptest.API, v variant, b map[string]any) *httptest.ResponseRecorder {
	b["expectedUpdatedAt"] = v.UpdatedAt
	return api.Put("/api/products/"+v.ProductID+"/variants/"+v.ID, api.Admin.Cookie, b)
}

func list(t *testing.T, api *apptest.API, cookie, query string) page {
	t.Helper()
	resp := api.Get("/api/products"+query, cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("list %s: got %d: %s", query, resp.Code, resp.Body)
	}
	return decode[page](t, resp)
}

func models(p page) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.ModelNumber)
	}
	return out
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

func assertError(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) problem {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d %s: %s", resp.Code, status, code, resp.Body)
	}
	p := decode[problem](t, resp)
	if p.Code != code {
		t.Fatalf("code %q, want %q: %s", p.Code, code, resp.Body)
	}
	return p
}

func errorLocations(errs []fieldError) []string {
	out := []string{}
	for _, e := range errs {
		out = append(out, e.Location+" "+e.Code)
	}
	return out
}

// uploadImage uploads a small PNG (distinct per seed) and returns its id.
func uploadImage(t *testing.T, api *apptest.API, seed int) string {
	t.Helper()
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewGray(image.Rect(0, 0, 1+seed, 1))); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreateFormFile("file", "x.png")
	_, _ = part.Write(img.Bytes())
	_ = w.Close()
	resp := api.Post("/api/files", api.Admin.Cookie, "Content-Type: "+w.FormDataContentType(), &body)
	if resp.Code != http.StatusCreated {
		t.Fatalf("upload: got %d: %s", resp.Code, resp.Body)
	}
	return decode[struct{ ID string }](t, resp).ID
}
