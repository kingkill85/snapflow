package proposals_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/document/docx/docxtest"
)

// gradient is a w×h PNG that does not compress to nothing.
func gradient(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x + y) % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// catalogImage uploads a catalog image (POST /api/files).
func catalogImage(t *testing.T, api *apptest.API, img []byte) string {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreateFormFile("file", "image.png")
	_, _ = part.Write(img)
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/files", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", api.Admin.Cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	wantCode(t, resp, http.StatusCreated, "")
	return decode[struct{ ID string }](t, resp).ID
}

// typeWithImage is newType with a variant image.
func typeWithImage(t *testing.T, api *apptest.API, key, price, imageID string) (string, string) {
	t.Helper()
	admin := api.Admin.Cookie
	resp := api.Post("/api/product-types", admin, map[string]any{"key": key, "name": text("Kameras"), "isActive": true, "abbreviation": "CAM"})
	wantCode(t, resp, http.StatusCreated, "")
	typeID := decode[struct{ ID string }](t, resp).ID
	for i, cat := range []string{"Innen", "Außen", "Türklingel", "Dome", "Bullet", "PTZ"} {
		resp = api.Post("/api/categories", admin, map[string]any{"key": key + "_" + string(rune('a'+i)), "name": text(cat), "isActive": true, "attributes": []any{}, "instanceAttributes": []any{}})
		wantCode(t, resp, http.StatusCreated, "")
	}
	catID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products", admin, map[string]any{"productTypeId": typeID, "categoryId": catID, "modelNumber": "CAM-PTZ-4K", "name": text("Schwenk-Neige-Kamera mit langer Produktbezeichnung"), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	productID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products/"+productID+"/variants", admin, map[string]any{"name": text("Weiß"), "sku": "CAM-W-01", "price": price, "isActive": true, "imageFileId": imageID})
	wantCode(t, resp, http.StatusCreated, "")
	return typeID, decode[struct{ ID string }](t, resp).ID
}

// TestLibreOffice generates real proposals (letterhead with logo, catalog
// images, a large plan, combined and split, German EUR and English USD with
// a name-only letterhead) and converts each to PDF with LibreOffice
// (docxtest: skipped without soffice, failing with REQUIRE_SOFFICE=1).
// KEEP_PDF=<dir> keeps the files.
func TestLibreOffice(t *testing.T) {
	soffice := docxtest.Soffice(t)
	api := apptest.New(t)
	acme, solo := api.NewTenant("Acme"), api.NewTenant("Solo")
	admin := api.NewUser(acme, auth.RoleTenantAdmin)
	resp := upload(t, api, "/api/tenants/"+acme.String()+"/logo", admin.Cookie, nil, gradient(t, 300, 100))
	wantCode(t, resp, http.StatusCreated, "")
	logo := decode[struct{ ID uuid.UUID }](t, resp).ID
	wantCode(t, api.Put("/api/tenants/"+acme.String()+"/letterhead", admin.Cookie, map[string]any{
		"companyName": "Acme Smart Homes GmbH", "address": "Hauptstraße 1\r\n12345 Berlin", "phone": "+49 30 123456",
		"email": "info@acme.example", "website": "acme.example", "logoFileId": logo,
	}), http.StatusOK, "")
	soloAdmin := api.NewUser(solo, auth.RoleTenantAdmin)
	wantCode(t, api.Put("/api/tenants/"+solo.String()+"/letterhead", soloAdmin.Cookie, map[string]any{"companyName": "Solo Installations Ltd"}), http.StatusOK, "")

	typeA, variantA := newType(t, api, "zigbee", "Dimmer", "19.99")
	typeC, variantC := typeWithImage(t, api, "cameras", "249.90", catalogImage(t, api, gradient(t, 400, 400)))
	files := map[string][]byte{}
	for _, run := range []struct {
		name, lang, currency, rate string
		cookie                     string
	}{
		{"de-eur", "de", "EUR", "0.9237", admin.Cookie},
		{"en-usd", "en", "USD", "1", soloAdmin.Cookie},
	} {
		resp := api.Post("/api/projects", run.cookie, map[string]any{
			"name": "Villa Sommer", "language": run.lang, "currency": run.currency, "exchangeRate": run.rate,
			"productTypeIds": []string{typeA, typeC}, "customer": map[string]any{"name": "Anna Kunde", "company": "Kunde GmbH", "address": "Weg 2\n10115 Berlin"},
		})
		wantCode(t, resp, http.StatusCreated, "")
		v := decode[project](t, resp).Versions[0].ID
		// A large plan (4000 × 3000) and two small ones.
		var many []any
		for i := range 12 {
			many = append(many, placement(variantA, float64(50+i*300), 1500, false), placement(variantC, float64(80+i*300), 900, i%4 == 0))
		}
		planWithImage(t, api, run.cookie, v, "Erdgeschoss mit Garten", gradient(t, 4000, 3000), many)
		planWith(t, api, run.cookie, v, "OG", []any{placement(variantA, 50, 50, false), placement(variantC, 150, 150, false)})
		planWith(t, api, run.cookie, v, "Keller", []any{placement(variantC, 50, 50, false)})
		wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", run.cookie, map[string]any{"name": "Kabelpauschale", "unitPrice": "30", "quantity": 1}), http.StatusCreated, "")
		wantCode(t, api.Put("/api/versions/"+v.String()+"/pricing", run.cookie, map[string]any{
			"discountKind": "amount", "discountValue": "25", "servicesKind": "percent", "servicesValue": "10",
			"introText": map[string]string{"en": "Thank you for your enquiry.", "de": "Vielen Dank für Ihre Anfrage.\r\nZweite Zeile."}, "expectedUpdatedAt": nil,
		}), http.StatusOK, "")
		for _, body := range []map[string]any{{"exporter": "docx"}, {"exporter": "docx", "split": true, "productTypeIds": []string{typeA, typeC}}} {
			resp = generate(api, run.cookie, v, body)
			wantCode(t, resp, http.StatusCreated, "")
			for _, p := range decode[[]proposals.Proposal](t, resp) {
				dl := api.Get(p.DownloadURL, run.cookie)
				wantCode(t, dl, http.StatusOK, "")
				kind := "combined"
				if p.ProductType != nil {
					kind = "split-" + p.ProductType.Name["en"]
				}
				parts := unzip(t, dl.Body.Bytes())
				for name, data := range parts {
					if strings.HasPrefix(name, "word/media/") {
						cfg, err := png.DecodeConfig(strings.NewReader(data))
						if err != nil || max(cfg.Width, cfg.Height) > 2400 {
							t.Errorf("%s %s: %d × %d (%v)", run.name, name, cfg.Width, cfg.Height, err)
						}
					}
				}
				files[run.name+"-"+kind+".docx"] = dl.Body.Bytes()
			}
		}
	}
	if len(files) != 6 {
		t.Fatalf("%d documents", len(files))
	}
	docxtest.ConvertToPDF(t, soffice, files)
}
