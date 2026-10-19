package plans_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
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

func wantCode(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("want %d %s, got %d: %s", status, code, resp.Code, resp.Body)
	}
	if code != "" && !strings.Contains(resp.Body.String(), `"`+code+`"`) {
		t.Fatalf("want code %s: %s", code, resp.Body)
	}
}

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

// fields returns "location code" of every field error.
func fields(t *testing.T, resp *httptest.ResponseRecorder) []string {
	t.Helper()
	wantCode(t, resp, http.StatusUnprocessableEntity, "")
	var out []string
	for _, f := range decode[problem](t, resp).Fields {
		out = append(out, f.Location+" "+f.Code)
	}
	return out
}

func text(en string) map[string]string { return map[string]string{"en": en} }

// catalog is a product type with a category (instance attribute "address",
// integer 1-255) and a product with three variants: main, which has the
// optional add-on opt and the required add-on req.
type catalog struct {
	TypeID, CategoryID, ProductID string
	Main, Opt, Req, Other         string
}

func newCatalog(t *testing.T, api *apptest.API, key string) catalog {
	t.Helper()
	admin := api.Admin.Cookie
	resp := api.Post("/api/product-types", admin, map[string]any{
		"key": key, "name": text(key), "abbreviation": "zb", "color": "#1f6feb", "isActive": true,
	})
	wantCode(t, resp, http.StatusCreated, "")
	var c catalog
	c.TypeID = decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/categories", admin, map[string]any{
		"key": key, "name": text(key), "isActive": true, "attributes": []any{},
		"instanceAttributes": []any{map[string]any{"key": "address", "label": text("Address"), "type": "integer", "min": 1, "max": 255}},
	})
	wantCode(t, resp, http.StatusCreated, "")
	c.CategoryID = decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products", admin, map[string]any{
		"productTypeId": c.TypeID, "categoryId": c.CategoryID, "modelNumber": key + "-1", "name": text("Dimmer"), "isActive": true,
	})
	wantCode(t, resp, http.StatusCreated, "")
	c.ProductID = decode[struct{ ID string }](t, resp).ID
	variant := func(name string) string {
		resp := api.Post("/api/products/"+c.ProductID+"/variants", admin, map[string]any{"name": text(name), "price": "10.00", "isActive": true})
		wantCode(t, resp, http.StatusCreated, "")
		return decode[struct{ ID string }](t, resp).ID
	}
	c.Main, c.Opt, c.Req, c.Other = variant("Main"), variant("Optional"), variant("Required"), variant("Other")
	resp = api.Put("/api/products/"+c.ProductID+"/variants/"+c.Main+"/addons", admin, map[string]any{"addons": []any{
		map[string]any{"addonVariantId": c.Opt, "required": false},
		map[string]any{"addonVariantId": c.Req, "required": true},
	}})
	wantCode(t, resp, http.StatusOK, "")
	return c
}

type project struct {
	ID       uuid.UUID `json:"id"`
	Versions []struct {
		ID uuid.UUID `json:"id"`
	} `json:"versions"`
	UpdatedAt string `json:"updatedAt"`
}

func newProject(t *testing.T, api *apptest.API, cookie string, typeIDs ...string) project {
	t.Helper()
	resp := api.Post("/api/projects", cookie, map[string]any{"name": "House", "productTypeIds": typeIDs})
	wantCode(t, resp, http.StatusCreated, "")
	return decode[project](t, resp)
}

// pngImage is a w×h PNG.
func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.NRGBA{R: 200, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// pngHeader is a PNG whose header claims w×h pixels (the image data is
// that of a 1×1 image): enough for the pixel limit, which reads only the
// header.
func pngHeader(t *testing.T, w, h uint32) []byte {
	t.Helper()
	data := pngImage(t, 1, 1)
	// IHDR: 8 signature, 4 length, 4 type, 13 data, 4 crc.
	binary.BigEndian.PutUint32(data[16:], w)
	binary.BigEndian.PutUint32(data[20:], h)
	binary.BigEndian.PutUint32(data[29:], crc32.ChecksumIEEE(data[12:29]))
	return data
}

// webpImage is a 1×1 lossless WebP.
func webpImage(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// multipartRequest sends fields and an optional image as a multipart form.
func multipartRequest(t *testing.T, api *apptest.API, method, path, cookie string, fields map[string]string, img []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if img != nil {
		part, err := w.CreateFormFile("image", "plan.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(img); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie[len("Cookie: "):])
	}
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	return resp
}

func createPlanResp(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string, img []byte) *httptest.ResponseRecorder {
	t.Helper()
	return multipartRequest(t, api, http.MethodPost, "/api/versions/"+versionID.String()+"/plans", cookie, map[string]string{"name": name}, img)
}

func createPlan(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string, w, h int) plans.Plan {
	t.Helper()
	resp := createPlanResp(t, api, cookie, versionID, name, pngImage(t, w, h))
	wantCode(t, resp, http.StatusCreated, "")
	return decode[plans.Plan](t, resp)
}

func getPlan(t *testing.T, api *apptest.API, cookie string, id uuid.UUID) plans.Plan {
	t.Helper()
	resp := api.Get("/api/plans/"+id.String(), cookie)
	wantCode(t, resp, http.StatusOK, "")
	return decode[plans.Plan](t, resp)
}

func getContent(t *testing.T, api *apptest.API, cookie string, id uuid.UUID) plans.PlanContent {
	t.Helper()
	resp := api.Get("/api/plans/"+id.String()+"/content", cookie)
	wantCode(t, resp, http.StatusOK, "")
	return decode[plans.PlanContent](t, resp)
}

func lock(t *testing.T, api *apptest.API, cookie string, id uuid.UUID) plans.PlanLock {
	t.Helper()
	resp := api.Post("/api/plans/"+id.String()+"/lock", cookie, map[string]any{})
	wantCode(t, resp, http.StatusOK, "")
	return decode[plans.PlanLock](t, resp)
}

// save sends content with expectedContentUpdatedAt from c.
func save(api *apptest.API, cookie string, c plans.PlanContent, zones, placements []any) *httptest.ResponseRecorder {
	if zones == nil {
		zones = []any{}
	}
	if placements == nil {
		placements = []any{}
	}
	return api.Put("/api/plans/"+c.PlanID.String()+"/content", cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": c.Scale, "zones": zones, "placements": placements,
	})
}

func zone(id uuid.UUID, pts ...[2]float64) map[string]any {
	return map[string]any{"id": id, "name": "Room", "color": "#AABBCC", "opacity": 0.3, "points": pts}
}

func rect(x0, y0, x1, y1 float64) [][2]float64 {
	return [][2]float64{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}
}

func placement(id uuid.UUID, variantID string, x, y float64) map[string]any {
	return map[string]any{
		"id": id, "variantId": variantID, "x": x, "y": y, "width": 20, "height": 20, "rotation": 0,
		"label": "", "existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{},
	}
}
