package proposals_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals/store"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
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

func text(en string) map[string]string { return map[string]string{"en": en} }

// newType creates a product type with a category and a product with one
// variant at price; it returns the type and variant ids.
func newType(t *testing.T, api *apptest.API, key, product, price string) (string, string) {
	t.Helper()
	admin := api.Admin.Cookie
	resp := api.Post("/api/product-types", admin, map[string]any{"key": key, "name": text(strings.ToUpper(key[:1]) + key[1:]), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	typeID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/categories", admin, map[string]any{"key": key + "_cat", "name": text(key + " devices"), "isActive": true, "attributes": []any{}, "instanceAttributes": []any{}})
	wantCode(t, resp, http.StatusCreated, "")
	catID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products", admin, map[string]any{"productTypeId": typeID, "categoryId": catID, "modelNumber": key + "-M1", "name": text(product), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	productID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products/"+productID+"/variants", admin, map[string]any{"name": text("Standard"), "price": price, "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	return typeID, decode[struct{ ID string }](t, resp).ID
}

type project struct {
	ID        uuid.UUID `json:"id"`
	Number    string    `json:"number"`
	UpdatedAt string    `json:"updatedAt"`
	Versions  []struct {
		ID uuid.UUID `json:"id"`
	} `json:"versions"`
}

func pngBytes(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func upload(t *testing.T, api *apptest.API, path, cookie string, fields map[string]string, img []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	part, _ := w.CreateFormFile("image", "image.png")
	_, _ = part.Write(img)
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, path, &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie[len("Cookie: "):])
	}
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	return resp
}

// planWith adds a plan with one zone and the given placements.
func planWith(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string, placements []any) {
	t.Helper()
	planWithImage(t, api, cookie, versionID, name, pngBytes(t, 400, 300, color.White), placements)
}

func planWithImage(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string, img []byte, placements []any) {
	t.Helper()
	resp := upload(t, api, "/api/versions/"+versionID.String()+"/plans", cookie, map[string]string{"name": name}, img)
	wantCode(t, resp, http.StatusCreated, "")
	p := decode[plans.Plan](t, resp)
	wantCode(t, api.Post("/api/plans/"+p.ID.String()+"/lock", cookie, map[string]any{}), http.StatusOK, "")
	resp = api.Get("/api/plans/"+p.ID.String()+"/content", cookie)
	wantCode(t, resp, http.StatusOK, "")
	c := decode[plans.PlanContent](t, resp)
	zone := map[string]any{"id": uuid.New(), "name": "Living room", "color": "#4f7cff", "opacity": 0.25,
		"points": [][2]float64{{10, 10}, {200, 10}, {200, 200}, {10, 200}}}
	wantCode(t, api.Put("/api/plans/"+p.ID.String()+"/content", cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "zones": []any{zone}, "placements": placements,
	}), http.StatusOK, "")
}

func placement(variantID string, x, y float64, existing bool) map[string]any {
	return map[string]any{
		"id": uuid.New(), "variantId": variantID, "x": x, "y": y, "width": 30, "height": 20, "rotation": 30,
		"label": "L", "existing": existing, "addonVariantIds": []string{}, "instanceValues": map[string]any{},
	}
}

func unzip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range z.File {
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		out[f.Name] = string(b)
	}
	return out
}

type fixture struct {
	project            project
	version            uuid.UUID
	typeA, typeB       string
	variantA, variantB string
}

// setup: a German EUR project (rate 0.5) of tenant Acme with two product
// types, two plans, an existing device, a free-text line and pricing with
// absolute amounts and texts.
func setup(t *testing.T, api *apptest.API, cookie string) fixture {
	t.Helper()
	var f fixture
	f.typeA, f.variantA = newType(t, api, "zigbee", "Dimmer", "100.00")
	f.typeB, f.variantB = newType(t, api, "knx", "Actuator", "50.00")
	resp := api.Post("/api/projects", cookie, map[string]any{
		"name": "Villa Sommer: Süd", "language": "de", "currency": "EUR", "exchangeRate": "0.5",
		"productTypeIds": []string{f.typeA, f.typeB}, "customer": map[string]any{"name": "Anna Kunde", "company": "Kunde GmbH"},
	})
	wantCode(t, resp, http.StatusCreated, "")
	f.project = decode[project](t, resp)
	f.version = f.project.Versions[0].ID
	planWith(t, api, cookie, f.version, "EG", []any{placement(f.variantA, 50, 50, false), placement(f.variantB, 300, 250, false), placement(f.variantB, 100, 100, true)})
	planWith(t, api, cookie, f.version, "OG", []any{placement(f.variantA, 50, 50, false)})
	wantCode(t, api.Post("/api/versions/"+f.version.String()+"/manual-lines", cookie, map[string]any{"name": "Kabelpauschale", "unitPrice": "30", "quantity": 1}), http.StatusCreated, "")
	wantCode(t, api.Put("/api/versions/"+f.version.String()+"/pricing", cookie, map[string]any{
		"discountKind": "amount", "discountValue": "25", "servicesKind": "percent", "servicesValue": "10",
		"introText": map[string]string{"en": "Thank you", "de": "Vielen Dank für Ihre Anfrage"}, "closingText": map[string]string{"en": "Valid 30 days"},
		"expectedUpdatedAt": nil,
	}), http.StatusOK, "")
	return f
}

func generate(api *apptest.API, cookie string, versionID uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	return api.Post("/api/versions/"+versionID.String()+"/proposals", cookie, body)
}

func download(t *testing.T, api *apptest.API, cookie string, p proposals.Proposal) (*httptest.ResponseRecorder, map[string]string) {
	t.Helper()
	resp := api.Get(p.DownloadURL, cookie)
	wantCode(t, resp, http.StatusOK, "")
	return resp, unzip(t, resp.Body.Bytes())
}

func TestGenerate(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	f := setup(t, api, user.Cookie)

	resp := api.Get("/api/versions/"+f.version.String()+"/pricing", user.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	if p := decode[bom.Pricing](t, resp); p.IntroText["de"] != "Vielen Dank für Ihre Anfrage" || p.ClosingText["en"] != "Valid 30 days" {
		t.Errorf("pricing texts: %+v", p)
	}
	wantCode(t, api.Get("/api/exporters", user.Cookie), http.StatusOK, "docx")

	// Combined.
	resp = generate(api, user.Cookie, f.version, map[string]any{"exporter": "docx"})
	wantCode(t, resp, http.StatusCreated, "")
	combined := decode[[]proposals.Proposal](t, resp)
	if len(combined) != 1 {
		t.Fatalf("%d proposals", len(combined))
	}
	p := combined[0]
	b := decode[bom.BOM](t, api.Get("/api/versions/"+f.version.String()+"/bom", user.Cookie))
	if p.Number != f.project.Number+"-V1-01" || p.Language != "de" || p.ProductType != nil || p.Sequence != 1 {
		t.Errorf("proposal %+v", p)
	}
	if p.Totals.GrandTotal != b.Totals.GrandTotal || p.Totals.Converted == nil || p.Totals.Converted.GrandTotal != b.Totals.Converted.GrandTotal || p.Totals.Rate != "0.5" {
		t.Errorf("totals %+v, BOM %+v", p.Totals, b.Totals)
	}
	if p.Totals.RateSource != "manual" || p.Totals.RateDate == nil {
		t.Errorf("rate origin %+v", p.Totals)
	}
	if p.FileName != p.Number+" Villa Sommer- Süd.docx" || p.CreatedByName == "" {
		t.Errorf("file name %q, created by %q", p.FileName, p.CreatedByName)
	}
	dl, parts := download(t, api, user.Cookie, p)
	if cd := dl.Header().Get("Content-Disposition"); !strings.Contains(cd, `filename*=UTF-8''`) || !strings.Contains(cd, "S%C3%BCd.docx") || !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("disposition %q", cd)
	}
	doc := parts["word/document.xml"]
	for _, want := range []string{"Angebot", p.Number, "Vielen Dank für Ihre Anfrage", "Valid 30 days", "Kabelpauschale", "Weitere Positionen",
		"Kunde GmbH", "Stückliste", "Geräte je Zone", "Living room", "Keine Zone", "Gesamtsumme", "1 USD = 0,5 EUR (Kurs vom ", "Dimmer", "EG", "OG", `w:orient="landscape"`} {
		if !strings.Contains(doc, want) {
			t.Errorf("document lacks %q", want)
		}
	}
	// 2 plans: per-plan quantity columns; both plan images (+ catalog images none).
	if _, ok := parts["word/media/image2.png"]; !ok {
		t.Error("plan images missing")
	}
	if !strings.Contains(parts["word/header1.xml"], "Acme") || !strings.Contains(parts["word/footer1.xml"], "Seite") {
		t.Error("letterhead or page numbers missing")
	}
	// The grand total in the document is the converted one, German format.
	gt := strings.ReplaceAll(b.Totals.Converted.GrandTotal, ".", ",")
	if !strings.Contains(doc, gt+" EUR") {
		t.Errorf("document lacks the grand total %s EUR", gt)
	}

	// Split per product type.
	resp = generate(api, user.Cookie, f.version, map[string]any{"exporter": "docx", "split": true, "productTypeIds": []string{f.typeA, f.typeB}})
	wantCode(t, resp, http.StatusCreated, "")
	split := decode[[]proposals.Proposal](t, resp)
	if len(split) != 2 || split[0].Sequence != 2 || split[0].ProductType == nil {
		t.Fatalf("split %+v", split)
	}
	numbers := []string{split[0].Number, split[1].Number}
	if !strings.HasPrefix(numbers[0], f.project.Number+"-V1-02-") || numbers[0] == numbers[1] {
		t.Errorf("split numbers %v", numbers)
	}
	for _, sp := range split {
		_, parts := download(t, api, user.Cookie, sp)
		if strings.Contains(parts["word/document.xml"], "Kabelpauschale") {
			t.Errorf("free-text line in split document %s", sp.Number)
		}
	}
	// Preview gives the same totals.
	resp = api.Post("/api/versions/"+f.version.String()+"/proposals/preview", user.Cookie, map[string]any{"split": true, "productTypeIds": []string{f.typeA, f.typeB}})
	wantCode(t, resp, http.StatusOK, "")
	pv := decode[proposals.ProposalPreview](t, resp)
	preview := pv.Documents
	if len(preview) != 2 || preview[0].Totals.GrandTotal != split[0].Totals.GrandTotal {
		t.Errorf("preview %+v", preview)
	}
	// With an absolute discount the split documents and the free-text share
	// add up to the combined total, in USD and in the project currency.
	if pv.FreeText == nil || pv.FreeText.Converted == nil {
		t.Fatalf("no free-text share: %+v", pv)
	}
	sumUSD, sumConv := money.MustParse(pv.FreeText.GrandTotal), money.MustParse(*pv.FreeText.Converted)
	for _, d := range preview {
		sumUSD = sumUSD.Add(money.MustParse(d.Totals.GrandTotal))
		sumConv = sumConv.Add(money.MustParse(d.Totals.Converted.GrandTotal))
	}
	if money.USD(sumUSD) != b.Totals.GrandTotal || money.Format(sumConv, "EUR") != b.Totals.Converted.GrandTotal {
		t.Errorf("split + free text = %s / %s, combined %s / %s", sumUSD, sumConv, b.Totals.GrandTotal, b.Totals.Converted.GrandTotal)
	}
	// The free-text share is about the Kabelpauschale (30 USD = 15 EUR, less
	// its share of the discount, plus services).
	if pv.FreeText.GrandTotal == "0.00" {
		t.Errorf("free-text share %+v", pv.FreeText)
	}
	// Combined preview: no share.
	resp = api.Post("/api/versions/"+f.version.String()+"/proposals/preview", user.Cookie, map[string]any{})
	if pv := decode[proposals.ProposalPreview](t, resp); pv.FreeText != nil || len(pv.Documents) != 1 {
		t.Errorf("combined preview %+v", pv)
	}

	resp = api.Get("/api/versions/"+f.version.String()+"/proposals", user.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	list := decode[[]proposals.Proposal](t, resp)
	if len(list) != 3 || list[0].Sequence != 2 || list[2].Sequence != 1 || list[0].Can.Delete {
		t.Errorf("list %+v", list)
	}

	// A copied version starts without proposals.
	resp = api.Post("/api/projects/"+f.project.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V2", "sourceVersionId": f.version})
	wantCode(t, resp, http.StatusCreated, "")
	v2 := decode[struct{ ID uuid.UUID }](t, resp).ID
	if l := decode[[]proposals.Proposal](t, api.Get("/api/versions/"+v2.String()+"/proposals", user.Cookie)); len(l) != 0 {
		t.Errorf("copied proposals: %+v", l)
	}

	// Delete: projects.delete.
	wantCode(t, api.Delete("/api/proposals/"+p.ID.String(), user.Cookie), http.StatusForbidden, "auth.forbidden")
	tenantAdmin := api.NewUser(acme, auth.RoleTenantAdmin)
	wantCode(t, api.Delete("/api/proposals/"+p.ID.String(), tenantAdmin.Cookie), http.StatusNoContent, "")
	wantCode(t, api.Get(p.DownloadURL, user.Cookie), http.StatusNotFound, "proposal.not_found")
}

func TestErrors(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	typeA, _ := newType(t, api, "zigbee", "Dimmer", "100.00")
	typeB, variantB := newType(t, api, "knx", "Actuator", "50.00")
	resp := api.Post("/api/projects", user.Cookie, map[string]any{"name": "House", "productTypeIds": []string{typeA, typeB}})
	wantCode(t, resp, http.StatusCreated, "")
	v := decode[project](t, resp).Versions[0].ID

	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "pdf"}), http.StatusUnprocessableEntity, "proposal.exporter_unknown")
	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusUnprocessableEntity, "proposal.empty")
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", user.Cookie, map[string]any{"variantId": variantB, "quantity": 2}), http.StatusCreated, "")
	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "docx", "split": true}), http.StatusUnprocessableEntity, "proposal.product_types_required")
	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "docx", "split": true, "productTypeIds": []string{typeA}}), http.StatusUnprocessableEntity, "proposal.product_type_not_in_bom")
	// One plan or none: no per-plan columns; generation works without plans.
	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusCreated, "")
	wantCode(t, generate(api, "", v, map[string]any{"exporter": "docx"}), http.StatusUnauthorized, "")
}

func TestReadOnlyProject(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	_, variant := newType(t, api, "zigbee", "Dimmer", "100.00")
	resp := api.Post("/api/projects", user.Cookie, map[string]any{"name": "House"})
	wantCode(t, resp, http.StatusCreated, "")
	pr := decode[project](t, resp)
	v := pr.Versions[0].ID
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", user.Cookie, map[string]any{"variantId": variant, "quantity": 1}), http.StatusCreated, "")
	if _, err := api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, pr.ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, generate(api, user.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusCreated, "")
}

func TestAccessAndRLS(t *testing.T) {
	api := apptest.New(t)
	ctx := t.Context()
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleTenantAdmin)
	_, variant := newType(t, api, "zigbee", "Dimmer", "100.00")
	resp := api.Post("/api/projects", acmeUser.Cookie, map[string]any{"name": "House"})
	wantCode(t, resp, http.StatusCreated, "")
	v := decode[project](t, resp).Versions[0].ID
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", acmeUser.Cookie, map[string]any{"variantId": variant, "quantity": 1}), http.StatusCreated, "")
	resp = generate(api, acmeUser.Cookie, v, map[string]any{"exporter": "docx"})
	wantCode(t, resp, http.StatusCreated, "")
	p := decode[[]proposals.Proposal](t, resp)[0]

	wantCode(t, api.Get("/api/versions/"+v.String()+"/proposals", otherUser.Cookie), http.StatusNotFound, "project_version.not_found")
	wantCode(t, generate(api, otherUser.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusNotFound, "project_version.not_found")
	wantCode(t, api.Get(p.DownloadURL, otherUser.Cookie), http.StatusNotFound, "proposal.not_found")
	wantCode(t, api.Delete("/api/proposals/"+p.ID.String(), otherUser.Cookie), http.StatusNotFound, "proposal.not_found")
	// Admins see every tenant.
	wantCode(t, api.Get(p.DownloadURL, api.Admin.Cookie), http.StatusOK, "")

	// The store, scoped to the other tenant, sees and writes nothing of Acme.
	otherActor := auth.Actor{UserID: otherUser.UserID, TenantID: other, Role: auth.RoleTenantAdmin}
	tx, err := api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := database.SetScope(ctx, tx, otherActor); err != nil {
		t.Fatal(err)
	}
	q := store.New(tx)
	if rows, err := q.ListProposals(ctx, v); err != nil || len(rows) != 0 {
		t.Errorf("foreign proposals: %v %v", rows, err)
	}
	_, err = q.NextSeq(ctx, store.NextSeqParams{VersionID: v, TenantID: acme})
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Errorf("foreign counter: %v", err)
	}
}

func TestConcurrentNumbers(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	_, variant := newType(t, api, "zigbee", "Dimmer", "100.00")
	resp := api.Post("/api/projects", user.Cookie, map[string]any{"name": "House"})
	wantCode(t, resp, http.StatusCreated, "")
	v := decode[project](t, resp).Versions[0].ID
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", user.Cookie, map[string]any{"variantId": variant, "quantity": 1}), http.StatusCreated, "")
	const n = 6
	var wg sync.WaitGroup
	seqs := make(chan int32, n)
	for range n {
		wg.Go(func() {
			resp := generate(api, user.Cookie, v, map[string]any{"exporter": "docx"})
			if resp.Code != http.StatusCreated {
				t.Errorf("generate: %d %s", resp.Code, resp.Body)
				return
			}
			var out []proposals.Proposal
			_ = json.Unmarshal(resp.Body.Bytes(), &out)
			seqs <- out[0].Sequence
		})
	}
	wg.Wait()
	close(seqs)
	seen := map[int32]bool{}
	for s := range seqs {
		if seen[s] || s < 1 || s > n {
			t.Errorf("sequence %d repeated or out of range", s)
		}
		seen[s] = true
	}
}

func TestLetterhead(t *testing.T) {
	api := apptest.New(t)
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	tenantAdmin, user := api.NewUser(acme, auth.RoleTenantAdmin), api.NewUser(acme, auth.RoleUser)
	path := "/api/tenants/" + acme.String() + "/letterhead"

	wantCode(t, api.Get(path, user.Cookie), http.StatusForbidden, "auth.forbidden")
	wantCode(t, api.Get("/api/tenants/"+other.String()+"/letterhead", tenantAdmin.Cookie), http.StatusNotFound, "tenant.not_found")
	wantCode(t, api.Put(path, tenantAdmin.Cookie, map[string]any{"companyName": "Acme", "email": "not an email"}), http.StatusUnprocessableEntity, "validation.email")
	wantCode(t, api.Put(path, tenantAdmin.Cookie, map[string]any{"logoFileId": uuid.New()}), http.StatusUnprocessableEntity, "tenant.logo_not_found")

	resp := upload(t, api, "/api/tenants/"+acme.String()+"/logo", tenantAdmin.Cookie, nil, pngBytes(t, 120, 40, color.RGBA{200, 0, 0, 255}))
	wantCode(t, resp, http.StatusCreated, "")
	logo := decode[struct{ ID uuid.UUID }](t, resp).ID
	wantCode(t, upload(t, api, "/api/tenants/"+other.String()+"/logo", tenantAdmin.Cookie, nil, pngBytes(t, 10, 10, color.White)), http.StatusNotFound, "tenant.not_found")
	resp = api.Put(path, tenantAdmin.Cookie, map[string]any{
		"companyName": "Acme Smart Homes GmbH", "address": "Hauptstr. 1\n12345 Berlin", "phone": "+49 30 123",
		"email": "info@acme.example", "website": "acme.example", "logoFileId": logo,
	})
	wantCode(t, resp, http.StatusOK, "")
	if l := decode[tenants.Letterhead](t, resp); l.LogoURL == nil || l.CompanyName != "Acme Smart Homes GmbH" {
		t.Errorf("letterhead %+v", l)
	}
	// Admins see it on the tenant too.
	resp = api.Get("/api/tenants/"+acme.String(), api.Admin.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	if tn := decode[tenants.Tenant](t, resp); tn.Letterhead.Phone != "+49 30 123" {
		t.Errorf("tenant letterhead %+v", tn.Letterhead)
	}

	// The proposal prints it.
	_, variant := newType(t, api, "zigbee", "Dimmer", "100.00")
	resp = api.Post("/api/projects", user.Cookie, map[string]any{"name": "House"})
	wantCode(t, resp, http.StatusCreated, "")
	v := decode[project](t, resp).Versions[0].ID
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", user.Cookie, map[string]any{"variantId": variant, "quantity": 1}), http.StatusCreated, "")
	resp = generate(api, user.Cookie, v, map[string]any{"exporter": "docx"})
	wantCode(t, resp, http.StatusCreated, "")
	_, parts := download(t, api, user.Cookie, decode[[]proposals.Proposal](t, resp)[0])
	header := parts["word/header1.xml"]
	for _, want := range []string{"Acme Smart Homes GmbH", "Hauptstr. 1", "info@acme.example", "r:embed="} {
		if !strings.Contains(header, want) {
			t.Errorf("header lacks %q: %s", want, header)
		}
	}
	if !strings.Contains(parts["word/document.xml"], "Proposal") {
		t.Error("an English project gets an English proposal")
	}
}

func TestFileName(t *testing.T) {
	if got := proposals.FileName("2026-0007-V2-03", `A/B: "C"*`, "docx"); got != "2026-0007-V2-03 A-B- -C--.docx" {
		t.Errorf("file name %q", got)
	}
	if got := proposals.Disposition("2026 Süd;x.docx"); got != `attachment; filename="2026 S_d;x.docx"; filename*=UTF-8''2026%20S%C3%BCd%3Bx.docx` {
		t.Errorf("disposition %q", got)
	}
}

// A non-USD project without a rate: the BOM is in USD only, proposals are
// refused until a rate is set.
func TestRateMissing(t *testing.T) {
	api := apptest.New(t)
	typeA, variantA := newType(t, api, "zigbee", "Dimmer", "100.00")
	resp := api.Post("/api/projects", api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR", "productTypeIds": []string{typeA}})
	wantCode(t, resp, http.StatusCreated, "")
	pr := decode[project](t, resp)
	v := pr.Versions[0].ID
	planWith(t, api, api.Admin.Cookie, v, "EG", []any{placement(variantA, 50, 50, false)})
	b := decode[bom.BOM](t, api.Get("/api/versions/"+v.String()+"/bom", api.Admin.Cookie))
	if b.Totals.Currency != "EUR" || b.Totals.Rate != "" || b.Totals.Converted != nil || b.Lines[0].Converted != nil || b.Totals.GrandTotal != "100.00" {
		t.Fatalf("BOM without rate: %+v", b.Totals)
	}
	wantCode(t, generate(api, api.Admin.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusConflict, "proposal.rate_missing")
	wantCode(t, api.Put("/api/projects/"+pr.ID.String()+"/exchange-rate", api.Admin.Cookie, map[string]any{"rate": "0.9", "currency": "EUR"}), http.StatusOK, "")
	b = decode[bom.BOM](t, api.Get("/api/versions/"+v.String()+"/bom", api.Admin.Cookie))
	if b.Totals.Converted == nil || b.Totals.Converted.GrandTotal != "90.00" || b.Totals.RateSource != "manual" {
		t.Fatalf("BOM with rate: %+v", b.Totals)
	}
	wantCode(t, generate(api, api.Admin.Cookie, v, map[string]any{"exporter": "docx"}), http.StatusCreated, "")
}
