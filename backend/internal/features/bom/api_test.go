package bom_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
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

// catalog: one product type and category, product with main (20.00, the
// optional add-on opt 2.50 and the required add-on req 5.00) and other
// (7.00).
type catalog struct {
	TypeID, ProductID     string
	Main, Opt, Req, Other string
}

func newCatalog(t *testing.T, api *apptest.API, key string) catalog {
	t.Helper()
	admin := api.Admin.Cookie
	resp := api.Post("/api/product-types", admin, map[string]any{"key": key, "name": text(key), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	var c catalog
	c.TypeID = decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/categories", admin, map[string]any{"key": key, "name": text(key), "isActive": true, "attributes": []any{}, "instanceAttributes": []any{}})
	wantCode(t, resp, http.StatusCreated, "")
	catID := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/products", admin, map[string]any{"productTypeId": c.TypeID, "categoryId": catID, "modelNumber": key + "-1", "name": text("Dimmer"), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	c.ProductID = decode[struct{ ID string }](t, resp).ID
	variant := func(name, price string) string {
		resp := api.Post("/api/products/"+c.ProductID+"/variants", admin, map[string]any{"name": text(name), "price": price, "isActive": true})
		wantCode(t, resp, http.StatusCreated, "")
		return decode[struct{ ID string }](t, resp).ID
	}
	c.Main, c.Opt, c.Req, c.Other = variant("Main", "20.00"), variant("Optional", "2.50"), variant("Required", "5.00"), variant("Other", "7.00")
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
}

func newProject(t *testing.T, api *apptest.API, cookie string, body map[string]any) project {
	t.Helper()
	resp := api.Post("/api/projects", cookie, body)
	wantCode(t, resp, http.StatusCreated, "")
	return decode[project](t, resp)
}

func createPlan(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID, name string) plans.Plan {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 200, 200))
	var buf, body bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	w := multipart.NewWriter(&body)
	_ = w.WriteField("name", name)
	part, _ := w.CreateFormFile("image", "plan.png")
	_, _ = part.Write(buf.Bytes())
	_ = w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/versions/"+versionID.String()+"/plans", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	wantCode(t, resp, http.StatusCreated, "")
	p := decode[plans.Plan](t, resp)
	wantCode(t, api.Post("/api/plans/"+p.ID.String()+"/lock", cookie, map[string]any{}), http.StatusOK, "")
	return p
}

func saveContent(t *testing.T, api *apptest.API, cookie string, planID uuid.UUID, zones, placements []any) *httptest.ResponseRecorder {
	t.Helper()
	resp := api.Get("/api/plans/"+planID.String()+"/content", cookie)
	wantCode(t, resp, http.StatusOK, "")
	c := decode[plans.PlanContent](t, resp)
	if zones == nil {
		zones = []any{}
	}
	return api.Put("/api/plans/"+planID.String()+"/content", cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "zones": zones, "placements": placements,
	})
}

func placement(variantID string, x, y float64, existing bool, addons ...string) map[string]any {
	if addons == nil {
		addons = []string{}
	}
	return map[string]any{
		"id": uuid.New(), "variantId": variantID, "x": x, "y": y, "width": 20, "height": 20, "rotation": 0,
		"label": "", "existing": existing, "addonVariantIds": addons, "instanceValues": map[string]any{},
	}
}

func getBOM(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID) bom.BOM {
	t.Helper()
	resp := api.Get("/api/versions/"+versionID.String()+"/bom", cookie)
	wantCode(t, resp, http.StatusOK, "")
	return decode[bom.BOM](t, resp)
}

func line(t *testing.T, b bom.BOM, key string) bom.BOMLine {
	t.Helper()
	for _, l := range b.Lines {
		if l.Key == key {
			return l
		}
	}
	t.Fatalf("no line %s in %+v", key, b.Lines)
	return bom.BOMLine{}
}

func hasLine(b bom.BOM, key string) bool {
	for _, l := range b.Lines {
		if l.Key == key {
			return true
		}
	}
	return false
}

func TestBOM(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	c := newCatalog(t, api, "zigbee")
	p := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}, "currency": "EUR", "exchangeRate": "0.9"})
	v := p.Versions[0].ID
	vs := v.String()

	a, b := createPlan(t, api, admin, v, "Ground floor"), createPlan(t, api, admin, v, "First floor")
	zoneID := uuid.New()
	wantCode(t, saveContent(t, api, admin, a.ID,
		[]any{map[string]any{"id": zoneID, "name": "Kitchen", "color": "#aabbcc", "opacity": 0.3, "points": [][2]float64{{0, 0}, {100, 0}, {100, 100}, {0, 100}}}},
		[]any{placement(c.Main, 50, 50, false, c.Opt), placement(c.Main, 150, 150, false), placement(c.Other, 150, 50, true)}), http.StatusOK, "")
	wantCode(t, saveContent(t, api, admin, b.ID, nil, []any{placement(c.Main, 50, 50, false)}), http.StatusOK, "")

	// Manual lines: a catalog line merges into main's line, free text is its own.
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Main, "quantity": 2}), http.StatusCreated, "")
	resp := api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"name": "Cable", "unitPrice": "4.555", "quantity": 3})
	wantCode(t, resp, http.StatusUnprocessableEntity, "bom.unit_price_invalid")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"name": "Cable", "unitPrice": "4.50", "quantity": 0}), http.StatusUnprocessableEntity, "bom.quantity_range")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": uuid.New(), "quantity": 1}), http.StatusUnprocessableEntity, "bom.variant_not_found")
	resp = api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"name": "Cable", "unitPrice": "4.50", "quantity": 3, "note": "10 m"})
	wantCode(t, resp, http.StatusCreated, "")
	cable := decode[bom.ManualLine](t, resp)

	got := getBOM(t, api, admin, v)
	main := line(t, got, c.Main)
	if main.Kind != bom.KindCatalog || main.Quantity != 5 || main.Quantities.Manual != 2 ||
		main.Quantities.Plans[a.ID.String()] != 2 || main.Quantities.Plans[b.ID.String()] != 1 ||
		main.Quantities.Zones[zoneID.String()] != 1 || main.Quantities.Unzoned[a.ID.String()] != 1 ||
		main.UnitPrice != "20.00" || main.Total != "100.00" || main.Converted == nil || main.Converted.Total != "90.00" {
		t.Errorf("main line: %+v", main)
	}
	req := line(t, got, c.Req)
	if req.Kind != bom.KindAddOn || req.Quantity != 5 || len(req.AddOnOf) != 1 || req.AddOnOf[0].String() != c.Main || req.Total != "25.00" {
		t.Errorf("required add-on line: %+v", req)
	}
	if opt := line(t, got, c.Opt); opt.Kind != bom.KindAddOn || opt.Quantity != 1 || opt.Quantities.Zones[zoneID.String()] != 1 {
		t.Errorf("optional add-on line: %+v", opt)
	}
	if hasLine(got, c.Other) {
		t.Errorf("an existing placement is in the BOM")
	}
	if last := got.Lines[len(got.Lines)-1]; last.Kind != bom.KindFreeText || last.Key != cable.ID.String() || last.Total != "13.50" {
		t.Errorf("free text last: %+v", last)
	}
	if got.Totals.Subtotal != "141.00" || got.Totals.GrandTotal != "141.00" || got.Totals.Currency != "EUR" ||
		got.Totals.Converted == nil || got.Totals.Converted.GrandTotal != "126.90" {
		t.Errorf("totals: %+v %+v", got.Totals, got.Totals.Converted)
	}
	if len(got.Groups) != 2 || got.Groups[0].Subtotal != "127.50" || got.Groups[1].Kind != "freeText" || len(got.Plans) != 2 {
		t.Errorf("groups: %+v", got.Groups)
	}
	if !main.Status.Available || main.Status.Outdated {
		t.Errorf("status: %+v", main.Status)
	}

	// Pricing: preview, save, stale.
	resp = api.Post("/api/versions/"+vs+"/pricing/preview", admin, map[string]any{"discountKind": "percent", "discountValue": "150", "servicesKind": "none"})
	wantCode(t, resp, http.StatusUnprocessableEntity, "pricing.percent_range")
	resp = api.Post("/api/versions/"+vs+"/pricing/preview", admin, map[string]any{"discountKind": "percent", "discountValue": "10", "servicesKind": "amount", "servicesValue": "100"})
	wantCode(t, resp, http.StatusOK, "")
	if tot := decode[bom.BOMTotals](t, resp); tot.Discount != "14.10" || tot.Services != "100.00" || tot.GrandTotal != "226.90" {
		t.Errorf("preview: %+v", tot)
	}
	if again := getBOM(t, api, admin, v); again.Pricing.UpdatedAt != nil || again.Totals.GrandTotal != "141.00" {
		t.Errorf("the preview saved: %+v", again.Pricing)
	}
	put := map[string]any{"discountKind": "amount", "discountValue": "500", "servicesKind": "percent", "servicesValue": "10", "expectedUpdatedAt": nil}
	resp = api.Put("/api/versions/"+vs+"/pricing", admin, put)
	wantCode(t, resp, http.StatusOK, "")
	saved := decode[bom.BOM](t, resp)
	if saved.Totals.Discount != "141.00" || saved.Totals.Services != "0.00" || saved.Totals.GrandTotal != "0.00" || saved.Pricing.UpdatedAt == nil ||
		saved.Pricing.ServicesLabel["de"] != "Systemplanung, Programmierung & Inbetriebnahme" ||
		saved.Pricing.ServicesLabelDefault["en"] != "System design, programming & commissioning" {
		t.Errorf("saved pricing: %+v %+v", saved.Totals, saved.Pricing)
	}
	wantCode(t, api.Put("/api/versions/"+vs+"/pricing", admin, put), http.StatusConflict, "pricing.stale")

	// A label of its own; the default stays known, and {} follows it again.
	put = map[string]any{"discountKind": "amount", "discountValue": "500", "servicesKind": "percent", "servicesValue": "10", "servicesLabel": map[string]string{"en": "Programming"}, "expectedUpdatedAt": saved.Pricing.UpdatedAt}
	resp = api.Put("/api/versions/"+vs+"/pricing", admin, put)
	wantCode(t, resp, http.StatusOK, "")
	saved = decode[bom.BOM](t, resp)
	if saved.Pricing.ServicesLabel["en"] != "Programming" || saved.Pricing.ServicesLabelDefault["en"] != "System design, programming & commissioning" {
		t.Errorf("own label: %+v", saved.Pricing)
	}
	put["servicesLabel"], put["expectedUpdatedAt"] = map[string]string{}, saved.Pricing.UpdatedAt
	resp = api.Put("/api/versions/"+vs+"/pricing", admin, put)
	wantCode(t, resp, http.StatusOK, "")
	if saved = decode[bom.BOM](t, resp); saved.Pricing.ServicesLabel["en"] != "System design, programming & commissioning" {
		t.Errorf("default label again: %+v", saved.Pricing)
	}

	// A catalog change never changes the snapshot implicitly, also not on the
	// next content save; the BOM marks it outdated.
	if _, err := api.DB.Exec(t.Context(), `UPDATE product_variants SET price = 30 WHERE id = $1`, c.Main); err != nil {
		t.Fatal(err)
	}
	wantCode(t, saveContent(t, api, admin, b.ID, nil, []any{placement(c.Main, 60, 60, false)}), http.StatusOK, "")
	got = getBOM(t, api, admin, v)
	if m := line(t, got, c.Main); m.UnitPrice != "20.00" || !m.Status.Outdated {
		t.Errorf("implicit update: %+v %+v", m, m.Status)
	}

	// Deleting a variant keeps its snapshot and its count.
	wantCode(t, api.Delete("/api/products/"+c.ProductID+"/variants/"+c.Opt, api.Admin.Cookie), http.StatusNoContent, "")
	got = getBOM(t, api, admin, v)
	if o := line(t, got, c.Opt); o.Quantity != 1 || !o.Status.Deleted || o.UnitPrice != "2.50" {
		t.Errorf("deleted variant: %+v %+v", o, o.Status)
	}
	// Re-saving the plan keeps counting the placement of the deleted variant.
	resp = api.Get("/api/plans/"+a.ID.String()+"/content", admin)
	content := decode[plans.PlanContent](t, resp)
	inputs := make([]plans.PlanPlacementInput, len(content.Placements))
	for i, pl := range content.Placements {
		inputs[i] = pl.PlanPlacementInput
	}
	wantCode(t, api.Put("/api/plans/"+a.ID.String()+"/content", admin, map[string]any{
		"expectedContentUpdatedAt": content.ContentUpdatedAt, "scale": nil, "zones": content.Zones, "placements": inputs,
	}), http.StatusOK, "")
	if o := line(t, getBOM(t, api, admin, v), c.Opt); o.Quantity != 1 {
		t.Errorf("deleted variant after re-save: %+v", o)
	}

	// Catalog changes: field-level preview with the effect, then apply.
	resp = api.Get("/api/versions/"+vs+"/catalog-changes", admin)
	wantCode(t, resp, http.StatusOK, "")
	changes := decode[bom.CatalogChanges](t, resp)
	var mainChange, optChange *bom.CatalogChange
	for i, ch := range changes.Items {
		switch ch.VariantID.String() {
		case c.Main:
			mainChange = &changes.Items[i]
		case c.Opt:
			optChange = &changes.Items[i]
		}
	}
	if mainChange == nil || len(mainChange.Fields) != 1 || mainChange.Fields[0] != "unitPrice" || mainChange.Before.UnitPrice != "20.00" ||
		mainChange.After == nil || mainChange.After.UnitPrice != "30.00" || !mainChange.CanApply {
		t.Fatalf("main change: %+v", mainChange)
	}
	if optChange == nil || !optChange.Deleted || optChange.CanApply || optChange.After != nil {
		t.Errorf("deleted change: %+v", optChange)
	}
	// Discount 500 capped: grand total stays 0 + services 10 % of 0; use the
	// subtotal effect through the preview of the grand total instead.
	if changes.GrandTotal != "0.00" {
		t.Errorf("grand total: %s", changes.GrandTotal)
	}
	wantCode(t, api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{}), http.StatusUnprocessableEntity, "bom.nothing_selected")
	resp = api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{"all": true})
	wantCode(t, resp, http.StatusOK, "")
	res := decode[bom.ApplyResult](t, resp)
	if len(res.Updated) != 1 || res.Updated[0].String() != c.Main {
		t.Errorf("apply: %+v", res)
	}
	if m := line(t, getBOM(t, api, admin, v), c.Main); m.UnitPrice != "30.00" || m.Status.Outdated || m.Total != "150.00" {
		t.Errorf("after apply: %+v", m)
	}

	// Manual lines: update with stale check, reorder, delete.
	resp = api.Put("/api/versions/"+vs+"/manual-lines/"+cable.ID.String(), admin, map[string]any{"name": "Cable", "unitPrice": "5", "quantity": 1, "expectedUpdatedAt": cable.UpdatedAt})
	wantCode(t, resp, http.StatusOK, "")
	wantCode(t, api.Put("/api/versions/"+vs+"/manual-lines/"+cable.ID.String(), admin, map[string]any{"name": "Cable", "unitPrice": "5", "quantity": 1, "expectedUpdatedAt": cable.UpdatedAt}), http.StatusConflict, "bom.line_stale")
	lines := getBOM(t, api, admin, v).ManualLines
	if len(lines) != 2 || lines[1].UnitPrice != "5.00" {
		t.Fatalf("manual lines: %+v", lines)
	}
	wantCode(t, api.Put("/api/versions/"+vs+"/manual-lines/order", admin, map[string]any{"ids": []uuid.UUID{lines[1].ID}}), http.StatusUnprocessableEntity, "bom.order_mismatch")
	resp = api.Put("/api/versions/"+vs+"/manual-lines/order", admin, map[string]any{"ids": []uuid.UUID{lines[1].ID, lines[0].ID}})
	wantCode(t, resp, http.StatusOK, "")
	if l := decode[[]bom.ManualLine](t, resp); l[0].ID != cable.ID {
		t.Errorf("reorder: %+v", l)
	}

	// Version copy carries snapshots, manual lines and pricing.
	resp = api.Post("/api/projects/"+p.ID.String()+"/versions", admin, map[string]any{"name": "Copy", "sourceVersionId": v})
	wantCode(t, resp, http.StatusCreated, "")
	copyID := decode[struct{ ID uuid.UUID }](t, resp).ID
	src, cp := getBOM(t, api, admin, v), getBOM(t, api, admin, copyID)
	if cp.Totals.Subtotal != src.Totals.Subtotal || cp.Totals.GrandTotal != src.Totals.GrandTotal ||
		len(cp.Lines) != len(src.Lines) || len(cp.ManualLines) != 2 || cp.Pricing.DiscountKind != "amount" ||
		line(t, cp, c.Opt).Quantity != 1 || line(t, cp, c.Main).UnitPrice != "30.00" {
		t.Errorf("copy: %+v\nsource: %+v", cp, src)
	}
	wantCode(t, api.Delete("/api/versions/"+vs+"/manual-lines/"+cable.ID.String(), admin), http.StatusNoContent, "")
	if len(getBOM(t, api, admin, copyID).ManualLines) != 2 {
		t.Errorf("deleting in the source changed the copy")
	}

	// Read-only projects refuse changes, reading still works.
	if _, err := api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, p.ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, api.Put("/api/versions/"+vs+"/pricing", admin, map[string]any{"discountKind": "none", "servicesKind": "none", "expectedUpdatedAt": saved.Pricing.UpdatedAt}), http.StatusConflict, "project.read_only")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"name": "X", "unitPrice": "1", "quantity": 1}), http.StatusConflict, "project.read_only")
	wantCode(t, api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{"all": true}), http.StatusConflict, "project.read_only")
	getBOM(t, api, admin, v)
}

// Permissions and tenants: another tenant's version is not found; a user of
// the tenant may read and write.
func TestAccess(t *testing.T) {
	api := apptest.New(t)
	c := newCatalog(t, api, "knx")
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleUser)
	v := newProject(t, api, acmeUser.Cookie, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", acmeUser.Cookie, map[string]any{"variantId": c.Main, "quantity": 1}), http.StatusCreated, "")
	wantCode(t, api.Get("/api/versions/"+v.String()+"/bom", otherUser.Cookie), http.StatusNotFound, "project_version.not_found")
	wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", otherUser.Cookie, map[string]any{"name": "X", "unitPrice": "1", "quantity": 1}), http.StatusNotFound, "project_version.not_found")
	wantCode(t, api.Get("/api/versions/"+v.String()+"/bom", ""), http.StatusUnauthorized, "")
}

// Row-level security on the three tables: the store, called directly with
// another tenant's scope, sees and changes nothing of a foreign tenant.
func TestRowLevelSecurity(t *testing.T) {
	api := apptest.New(t)
	ctx := t.Context()
	c := newCatalog(t, api, "rls")
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	acmeUser, otherUser := api.NewUser(acme, auth.RoleUser), api.NewUser(other, auth.RoleUser)
	foreign := newProject(t, api, otherUser.Cookie, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	fs := foreign.String()
	wantCode(t, api.Post("/api/versions/"+fs+"/manual-lines", otherUser.Cookie, map[string]any{"variantId": c.Main, "quantity": 1}), http.StatusCreated, "")
	wantCode(t, api.Put("/api/versions/"+fs+"/pricing", otherUser.Cookie, map[string]any{"discountKind": "percent", "discountValue": "5", "servicesKind": "none", "expectedUpdatedAt": nil}), http.StatusOK, "")

	acmeActor := auth.Actor{UserID: acmeUser.UserID, TenantID: acme, Role: auth.RoleUser}
	scoped := func(fn func(q *store.Queries) error) error {
		t.Helper()
		tx, err := api.DB.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if err := database.SetScope(ctx, tx, acmeActor); err != nil {
			t.Fatal(err)
		}
		return fn(store.New(tx))
	}
	_ = scoped(func(q *store.Queries) error {
		if rows, err := q.ListItems(ctx, foreign); err != nil || len(rows) != 0 {
			t.Errorf("foreign items: %v %v", rows, err)
		}
		if rows, err := q.ListManualLines(ctx, foreign); err != nil || len(rows) != 0 {
			t.Errorf("foreign lines: %v %v", rows, err)
		}
		if _, err := q.GetPricing(ctx, foreign); !errors.Is(err, pgx.ErrNoRows) {
			t.Errorf("foreign pricing: %v", err)
		}
		return nil
	})
	for name, write := range map[string]func(q *store.Queries) error{
		"item": func(q *store.Queries) error {
			return q.InsertItem(ctx, store.InsertItemParams{TenantID: other, VersionID: foreign, VariantID: uuid.New(), ProductID: uuid.New(),
				ProductName: text("X"), VariantName: text("X"), ProductTypeName: text("X"), CategoryName: text("X"), UnitPrice: "1", RequiredAddonIds: []uuid.UUID{}})
		},
		"line": func(q *store.Queries) error {
			_, err := q.InsertManualLine(ctx, store.InsertManualLineParams{TenantID: other, VersionID: foreign, Quantity: 1, Name: ptr("X"), UnitPrice: ptr("1")})
			return err
		},
		"pricing": func(q *store.Queries) error {
			_, err := q.UpsertPricing(ctx, store.UpsertPricingParams{VersionID: foreign, TenantID: other, DiscountKind: "none", DiscountValue: "0", ServicesKind: "none", ServicesValue: "0"})
			return err
		},
	} {
		var pgErr *pgconn.PgError
		if err := scoped(write); !errors.As(err, &pgErr) || pgErr.Code != "42501" {
			t.Errorf("%s in another tenant: %v", name, err)
		}
	}
	var n int
	if err := api.DB.QueryRow(ctx, `SELECT (SELECT count(*) FROM version_items WHERE version_id = $1) + (SELECT count(*) FROM version_manual_lines WHERE version_id = $1)`, foreign).Scan(&n); err != nil || n != 3 {
		t.Errorf("foreign rows: %d %v", n, err)
	}
}

func ptr[T any](v T) *T { return &v }

// Concurrent first appearances of a variant (plan saves in parallel, each
// under its own plan lock) take one snapshot.
func TestConcurrentSnapshots(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	c := newCatalog(t, api, "conc")
	v := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	var ps []plans.Plan
	for i := range 4 {
		ps = append(ps, createPlan(t, api, admin, v, "Plan "+string(rune('A'+i))))
	}
	var wg sync.WaitGroup
	codes := make([]int, len(ps))
	for i, p := range ps {
		wg.Go(func() {
			codes[i] = saveContent(t, api, admin, p.ID, nil, []any{placement(c.Main, 50, 50, false, c.Opt)}).Code
		})
	}
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusOK && code != http.StatusConflict {
			t.Errorf("save %d: %d", i, code)
		}
	}
	var n int
	if err := api.DB.QueryRow(t.Context(), `SELECT count(*) FROM version_items WHERE version_id = $1 AND variant_id = $2`, v, c.Main).Scan(&n); err != nil || n != 1 {
		t.Errorf("snapshots of main: %d %v", n, err)
	}
	if got := getBOM(t, api, admin, v); line(t, got, c.Req).Quantity < 1 {
		t.Errorf("required add-on missing: %+v", got.Lines)
	}
}

// A pool of two connections serves concurrent content saves, manual lines
// and catalog applies: no request holds a transaction while it waits for a
// second pooled connection (D243).
func TestSmallPool(t *testing.T) {
	api := apptest.NewWithPool(t, testdb.SmallPool(t, 2))
	admin := api.Admin.Cookie
	c := newCatalog(t, api, "pool")
	v := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	vs := v.String()
	var ps []plans.Plan
	for i := range 4 {
		ps = append(ps, createPlan(t, api, admin, v, "Plan "+string(rune('A'+i))))
	}
	if _, err := api.DB.Exec(t.Context(), `UPDATE product_variants SET price = 21 WHERE id = $1`, c.Other); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	codes := make([]int, 0, 12)
	var mu sync.Mutex
	record := func(code int) {
		mu.Lock()
		codes = append(codes, code)
		mu.Unlock()
	}
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i, p := range ps {
			wg.Go(func() {
				pl := placement(c.Main, 50, 50, false, c.Opt)
				if i%2 == 1 {
					pl = placement(c.Other, 50, 50, false)
				}
				record(saveContent(t, api, admin, p.ID, nil, []any{pl}).Code)
			})
			wg.Go(func() {
				record(api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Other, "quantity": 1}).Code)
			})
			wg.Go(func() {
				record(api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{"all": true}).Code)
			})
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("requests did not finish: the pool starved")
	}
	for i, code := range codes {
		if code != http.StatusOK && code != http.StatusCreated && code != http.StatusConflict {
			t.Errorf("request %d: %d", i, code)
		}
	}
	if got := getBOM(t, api, admin, v); line(t, got, c.Req).Quantity < 1 || line(t, got, c.Other).Quantity < 4 {
		t.Errorf("lines: %+v", got.Lines)
	}
}

// A catalog reorder between two snapshots of one product type never splits
// its group: the position is settled per product type (D244).
func TestGroupsAfterReorder(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	a, b := newCatalog(t, api, "first"), newCatalog(t, api, "second")
	v := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{a.TypeID, b.TypeID}}).Versions[0].ID
	vs := v.String()
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": a.Main, "quantity": 1}), http.StatusCreated, "")
	wantCode(t, api.Put("/api/product-types/order", admin, map[string]any{"ids": []string{b.TypeID, a.TypeID}}), http.StatusOK, "")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": a.Other, "quantity": 1}), http.StatusCreated, "")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": b.Other, "quantity": 1}), http.StatusCreated, "")

	check := func(when string) {
		t.Helper()
		got := getBOM(t, api, admin, v)
		var types []string
		for _, g := range got.Groups {
			if g.Kind == "productType" {
				types = append(types, g.ProductType.ID.String())
				if len(g.Categories) != 1 {
					t.Errorf("%s: categories of %s: %+v", when, g.ProductType.Key, g.Categories)
				}
			}
		}
		if len(types) != 2 || types[0] != b.TypeID || types[1] != a.TypeID {
			t.Errorf("%s: groups %v, want [%s %s]", when, types, b.TypeID, a.TypeID)
		}
	}
	check("live order")
	// With the type's variants deleted, the newest snapshot's position
	// counts for all of them.
	if _, err := api.DB.Exec(t.Context(), `DELETE FROM product_variants WHERE product_id = $1`, a.ProductID); err != nil {
		t.Fatal(err)
	}
	check("snapshot order")
}

// Catalog-change effects without a discount cap: each item's effect is the
// difference applying only it makes, the preview's grand total after is the
// grand total after applying all; a new required add-on gets its snapshot
// and is counted.
func TestCatalogChangeEffects(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	c := newCatalog(t, api, "fx")
	v := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	vs := v.String()
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Main, "quantity": 2}), http.StatusCreated, "")
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Other, "quantity": 3}), http.StatusCreated, "")
	wantCode(t, api.Put("/api/versions/"+vs+"/pricing", admin, map[string]any{"discountKind": "percent", "discountValue": "10", "servicesKind": "amount", "servicesValue": "50", "expectedUpdatedAt": nil}), http.StatusOK, "")
	// Main 2 × (20 + required 5) + other 3 × 7 = 71; −7.10 + 50 = 113.90.
	if got := getBOM(t, api, admin, v); got.Totals.GrandTotal != "113.90" {
		t.Fatalf("grand total: %+v", got.Totals)
	}

	// Main costs 30 and gets a second required add-on (4.00); other costs 8.
	resp := api.Post("/api/products/"+c.ProductID+"/variants", admin, map[string]any{"name": text("Required 2"), "price": "4.00", "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	req2 := decode[struct{ ID string }](t, resp).ID
	wantCode(t, api.Put("/api/products/"+c.ProductID+"/variants/"+c.Main+"/addons", admin, map[string]any{"addons": []any{
		map[string]any{"addonVariantId": c.Opt, "required": false},
		map[string]any{"addonVariantId": c.Req, "required": true},
		map[string]any{"addonVariantId": req2, "required": true},
	}}), http.StatusOK, "")
	if _, err := api.DB.Exec(t.Context(), `UPDATE product_variants SET price = CASE id WHEN $1::uuid THEN 30 ELSE 8 END WHERE id IN ($1, $2)`, c.Main, c.Other); err != nil {
		t.Fatal(err)
	}

	resp = api.Get("/api/versions/"+vs+"/catalog-changes", admin)
	wantCode(t, resp, http.StatusOK, "")
	changes := decode[bom.CatalogChanges](t, resp)
	effects := map[string]string{}
	for _, ch := range changes.Items {
		effects[ch.VariantID.String()] = ch.Effect
	}
	// Main: 2 × (10 + 4) = 28 → × 0.9 = 25.20; other: 3 × 1 = 3 → 2.70.
	if effects[c.Main] != "25.20" || effects[c.Other] != "2.70" || changes.GrandTotal != "113.90" ||
		changes.GrandTotalAfter != "141.80" || changes.Effect != "27.90" {
		t.Fatalf("preview: %+v", changes)
	}

	resp = api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{"variantIds": []string{c.Main}})
	wantCode(t, resp, http.StatusOK, "")
	got := getBOM(t, api, admin, v)
	if got.Totals.GrandTotal != "139.10" {
		t.Errorf("after applying main (113.90 + 25.20): %+v", got.Totals)
	}
	if l := line(t, got, req2); l.Quantity != 2 || l.Kind != bom.KindAddOn || l.UnitPrice != "4.00" {
		t.Errorf("new required add-on: %+v", l)
	}
	wantCode(t, api.Post("/api/versions/"+vs+"/catalog-changes/apply", admin, map[string]any{"variantIds": []string{c.Other}}), http.StatusOK, "")
	if got := getBOM(t, api, admin, v); got.Totals.GrandTotal != changes.GrandTotalAfter {
		t.Errorf("after applying all: %s, preview said %s", got.Totals.GrandTotal, changes.GrandTotalAfter)
	}
}

// Conversion to currencies with 0 and 3 decimals, per line and in totals.
func TestCurrencyDecimals(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	c := newCatalog(t, api, "cur")
	for _, tc := range []struct{ currency, rate, unit, total, grand string }{
		// Main 20 × 3 = 60 (required add-on 5 × 3 = 15): subtotal 75.
		{"JPY", "150.5", "3010", "9030", "11288"},
		{"KWD", "0.3075", "6.150", "18.450", "23.063"},
	} {
		v := newProject(t, api, admin, map[string]any{"name": "House " + tc.currency, "productTypeIds": []string{c.TypeID}, "currency": tc.currency, "exchangeRate": tc.rate}).Versions[0].ID
		wantCode(t, api.Post("/api/versions/"+v.String()+"/manual-lines", admin, map[string]any{"variantId": c.Main, "quantity": 3}), http.StatusCreated, "")
		got := getBOM(t, api, admin, v)
		m := line(t, got, c.Main)
		if m.Converted == nil || m.Converted.UnitPrice != tc.unit || m.Converted.Total != tc.total {
			t.Errorf("%s line: %+v", tc.currency, m.Converted)
		}
		if got.Totals.Converted == nil || got.Totals.Converted.GrandTotal != tc.grand || got.Totals.Currency != tc.currency {
			t.Errorf("%s totals: %+v %+v", tc.currency, got.Totals, got.Totals.Converted)
		}
	}
}

// A new manual catalog line needs an available variant of a product type of
// the project; existing lines keep their variant when it is deactivated.
func TestManualLineAvailability(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	c, foreign := newCatalog(t, api, "avail"), newCatalog(t, api, "foreign")
	v := newProject(t, api, admin, map[string]any{"name": "House", "productTypeIds": []string{c.TypeID}}).Versions[0].ID
	vs := v.String()
	resp := api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Main, "quantity": 1})
	wantCode(t, resp, http.StatusCreated, "")
	existing := decode[bom.ManualLine](t, resp)
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": foreign.Main, "quantity": 1}), http.StatusUnprocessableEntity, "bom.product_type_not_in_project")
	if _, err := api.DB.Exec(t.Context(), `UPDATE product_variants SET is_active = false WHERE id = $1`, c.Main); err != nil {
		t.Fatal(err)
	}
	wantCode(t, api.Post("/api/versions/"+vs+"/manual-lines", admin, map[string]any{"variantId": c.Main, "quantity": 1}), http.StatusUnprocessableEntity, "bom.variant_unavailable")
	wantCode(t, api.Put("/api/versions/"+vs+"/manual-lines/"+existing.ID.String(), admin, map[string]any{"variantId": c.Main, "quantity": 4, "expectedUpdatedAt": existing.UpdatedAt}), http.StatusOK, "")
	if l := line(t, getBOM(t, api, admin, v), c.Main); l.Quantity != 4 || !l.Status.Inactive {
		t.Errorf("existing line: %+v %+v", l, l.Status)
	}
}
