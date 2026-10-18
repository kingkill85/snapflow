package imports_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/color"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc/importsrctest"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

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

func assertError(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) problem {
	t.Helper()
	expect(t, resp, status)
	p := decode[problem](t, resp)
	if p.Code != code {
		t.Fatalf("code %q, want %q: %s", p.Code, code, resp.Body)
	}
	return p
}

// fieldCodes returns "location code" for each field error.
func fieldCodes(p problem) []string {
	out := []string{}
	for _, f := range p.Fields {
		out = append(out, f.Location+" "+f.Code)
	}
	return out
}

// uploadRaw posts a file to /api/imports.
func uploadRaw(api *apptest.API, cookie, name string, data []byte) *httptest.ResponseRecorder {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreateFormFile("file", name)
	_, _ = part.Write(data)
	_ = w.Close()
	return api.Post("/api/imports", cookie, "Content-Type: "+w.FormDataContentType(), &body)
}

// upload uploads and previews with a profile ("" uploads only).
func upload(t *testing.T, api *apptest.API, name string, data []byte, profileID string) imports.ImportRun {
	t.Helper()
	resp := uploadRaw(api, api.Admin.Cookie, name, data)
	expect(t, resp, http.StatusCreated)
	run := decode[imports.ImportRun](t, resp)
	if profileID != "" {
		return preview(t, api, run.ID.String(), map[string]any{"profileId": profileID})
	}
	return run
}

func preview(t *testing.T, api *apptest.API, runID string, body any) imports.ImportRun {
	t.Helper()
	resp := api.Post("/api/imports/"+runID+"/preview", api.Admin.Cookie, body)
	expect(t, resp, http.StatusOK)
	return decode[imports.ImportRun](t, resp)
}

func apply(t *testing.T, api *apptest.API, runID string, body any) imports.ImportRun {
	t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	resp := api.Post("/api/imports/"+runID+"/apply", api.Admin.Cookie, body)
	expect(t, resp, http.StatusOK)
	return decode[imports.ImportRun](t, resp)
}

func undo(t *testing.T, api *apptest.API, runID string) imports.ImportRun {
	t.Helper()
	resp := api.Post("/api/imports/"+runID+"/undo", api.Admin.Cookie, map[string]any{})
	expect(t, resp, http.StatusOK)
	return decode[imports.ImportRun](t, resp)
}

// starterID returns the starter profile's id (created on first list),
// creating the product type it needs (key "zigbee") first if missing.
func starterID(t *testing.T, api *apptest.API) string {
	t.Helper()
	if _, ok := productTypes(t, api)[imports.StarterProductType]; !ok {
		newProductType(t, api, imports.StarterProductType, "ZB")
	}
	for _, p := range decode[[]imports.ImportProfile](t, api.Get("/api/import-profiles", api.Admin.Cookie)) {
		if p.Name == imports.StarterProfileName {
			return p.ID.String()
		}
	}
	t.Fatal("no starter profile")
	return ""
}

// items returns every diff item of a run.
func items(t *testing.T, api *apptest.API, runID, query string) []imports.ImportItem {
	t.Helper()
	page := decode[imports.ImportItemPage](t, api.Get("/api/imports/"+runID+"/items?limit=500&"+query, api.Admin.Cookie))
	return page.Items
}

func issues(t *testing.T, api *apptest.API, runID string) []imports.ImportIssue {
	t.Helper()
	return decode[imports.ImportIssuePage](t, api.Get("/api/imports/"+runID+"/issues?limit=500", api.Admin.Cookie)).Items
}

// item finds a diff item by entity, model number and (variants) English
// name.
func item(t *testing.T, list []imports.ImportItem, entity, model, name string) imports.ImportItem {
	t.Helper()
	for _, it := range list {
		if it.Entity == entity && it.ModelNumber == model && (name == "" || it.Name["en"] == name) {
			return it
		}
	}
	t.Fatalf("no %s item %s %s", entity, model, name)
	return imports.ImportItem{}
}

func change(it imports.ImportItem, field string) *imports.ImportFieldChange {
	for i := range it.Changes {
		if it.Changes[i].Field == field {
			return &it.Changes[i]
		}
	}
	return nil
}

// Catalog reads through the products API.

type addon struct {
	AddonVariantID string `json:"addonVariantId"`
	ModelNumber    string `json:"modelNumber"`
	Required       bool   `json:"required"`
}

type variant struct {
	ID          string            `json:"id"`
	Name        map[string]string `json:"name"`
	SKU         string            `json:"sku"`
	Price       string            `json:"price"`
	ImageFileID string            `json:"imageFileId"`
	Attributes  map[string]any    `json:"attributes"`
	IsActive    bool              `json:"isActive"`
	Addons      []addon           `json:"addons"`
	UpdatedAt   string            `json:"updatedAt"`
}

type product struct {
	ID            string `json:"id"`
	ProductTypeID string `json:"productTypeId"`
	ProductType   struct{ Key string }
	CategoryID    string `json:"categoryId"`
	Category      struct{ Key string }
	ModelNumber   string            `json:"modelNumber"`
	Name          map[string]string `json:"name"`
	Description   map[string]string `json:"description"`
	Attributes    map[string]any    `json:"attributes"`
	IsActive      bool              `json:"isActive"`
	Variants      []variant         `json:"variants"`
	UpdatedAt     string            `json:"updatedAt"`
}

// catalog returns every product with its variants, by model number.
func catalog(t *testing.T, api *apptest.API) map[string]product {
	t.Helper()
	page := decode[struct {
		Items []struct{ ID string } `json:"items"`
	}](t, api.Get("/api/products?includeInactive=true&limit=200", api.Admin.Cookie))
	out := map[string]product{}
	for _, it := range page.Items {
		p := decode[product](t, api.Get("/api/products/"+it.ID, api.Admin.Cookie))
		out[p.ModelNumber] = p
	}
	return out
}

func variantByName(t *testing.T, p product, name string) variant {
	t.Helper()
	for _, v := range p.Variants {
		if v.Name["en"] == name {
			return v
		}
	}
	t.Fatalf("%s has no variant %q", p.ModelNumber, name)
	return variant{}
}

type productType struct {
	ID           string         `json:"id"`
	Key          string         `json:"key"`
	Name         map[string]any `json:"name"`
	Abbreviation string         `json:"abbreviation"`
	UpdatedAt    string         `json:"updatedAt"`
}

func productTypes(t *testing.T, api *apptest.API) map[string]productType {
	t.Helper()
	out := map[string]productType{}
	for _, pt := range decode[struct{ Items []productType }](t, api.Get("/api/product-types?includeInactive=true", api.Admin.Cookie)).Items {
		out[pt.Key] = pt
	}
	return out
}

// newProductType creates a product type (system) with an English name equal
// to its key.
func newProductType(t *testing.T, api *apptest.API, key, abbreviation string) productType {
	t.Helper()
	resp := api.Post("/api/product-types", api.Admin.Cookie, map[string]any{
		"key": key, "name": map[string]string{"en": key}, "abbreviation": abbreviation, "isActive": true,
	})
	expect(t, resp, http.StatusCreated)
	return decode[productType](t, resp)
}

type category struct {
	ID         string           `json:"id"`
	Key        string           `json:"key"`
	Name       map[string]any   `json:"name"`
	Attributes []map[string]any `json:"attributes"`
	UpdatedAt  string           `json:"updatedAt"`
}

func categoryList(t *testing.T, api *apptest.API) map[string]category {
	t.Helper()
	out := map[string]category{}
	for _, c := range decode[struct{ Items []category }](t, api.Get("/api/categories?includeInactive=true", api.Admin.Cookie)).Items {
		out[c.Key] = c
	}
	return out
}

// newCategory creates a category; name is its English name (the key when
// empty).
func newCategory(t *testing.T, api *apptest.API, key, name string, attributes []any) category {
	t.Helper()
	if attributes == nil {
		attributes = []any{}
	}
	if name == "" {
		name = key
	}
	resp := api.Post("/api/categories", api.Admin.Cookie, map[string]any{
		"key": key, "name": map[string]string{"en": name}, "isActive": true, "attributes": attributes, "instanceAttributes": []any{},
	})
	expect(t, resp, http.StatusCreated)
	return decode[category](t, resp)
}

// newProduct creates a product by hand (no variants).
func newProduct(t *testing.T, api *apptest.API, typeID, categoryID, model string) product {
	t.Helper()
	resp := api.Post("/api/products", api.Admin.Cookie, map[string]any{
		"productTypeId": typeID, "categoryId": categoryID, "modelNumber": model, "name": map[string]string{"en": model}, "isActive": true,
	})
	expect(t, resp, http.StatusCreated)
	return decode[product](t, resp)
}

// Fixtures.

var (
	red   = color.RGBA{255, 0, 0, 255}
	blue  = color.RGBA{0, 0, 255, 255}
	green = color.RGBA{0, 255, 0, 255}
)

// v1Rows is a small SnapFlow 1 workbook: two gateway variants (the second
// without its own picture), a spacer row, two panel variants with add-ons
// (one reference with a double space, one in other case), a frame, a track
// without style.
func v1Rows(t *testing.T) []importsrctest.V1Row {
	t.Helper()
	return []importsrctest.V1Row{
		{Category: "Gateways", Name: "Zigbee Gateway", Description: "Gateway  for Zigbee", Model: "GW-1", Dimensions: "45*47*19",
			Style: "White", Price: 108, Images: [][]byte{importsrctest.PNG(t, red)}},
		{Category: "Gateways", Name: "Zigbee Gateway", Model: "GW-1", Dimensions: "45*47*19", Style: "Black", Price: 110},
		{Spacer: true},
		{Category: "Smart Panels", Name: "Tile 1 Button", Model: "T-1", Dimensions: "86*86*10.5", Style: "Ivory White", Price: 27,
			Required: []string{"F-1  Ivory White"}, Optional: []string{"GW-1 White"},
			Images: [][]byte{importsrctest.PNG(t, green), importsrctest.PNG(t, blue)}, OneCell: []bool{true, false}},
		{Category: "Smart Panels", Name: "Tile 1 Button", Model: "T-1", Style: "Ash Grey", Price: "27,5",
			Required: []string{"f-1 ivory white"}},
		{Category: "Frames", Name: "Tile Frame", Model: "F-1", Style: "Ivory White", Price: 4.5},
		{Category: "Shading", Name: "Blind Motor Track", Model: "TR-1", Dimensions: "/", Price: "20"},
	}
}

func workbook(t *testing.T, rows []importsrctest.V1Row) []byte {
	t.Helper()
	return importsrctest.V1Workbook(t, rows)
}

func str(s string) *string { return &s }

func csvFile(lines ...string) []byte {
	var b bytes.Buffer
	for _, l := range lines {
		fmt.Fprintln(&b, l)
	}
	return b.Bytes()
}
