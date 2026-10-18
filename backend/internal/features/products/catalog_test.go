package products_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	filesstore "github.com/kingkill85/snapflow/backend/internal/features/files/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

func service(t *testing.T, api *apptest.API) (*products.Service, context.Context) {
	t.Helper()
	storage, err := files.NewStorage(api.StorageDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := products.NewService(api.DB, producttypes.NewService(api.DB), categories.NewService(api.DB), files.NewService(filesstore.New(api.DB), storage))
	ctx := auth.WithActor(context.Background(), auth.Actor{UserID: api.Admin.UserID, TenantID: api.Admin.TenantID, Role: auth.RoleAdmin})
	return svc, ctx
}

func code(err error) string {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		if len(ae.Fields) > 0 {
			return ae.Fields[0].Code
		}
		return ae.Code
	}
	return ""
}

// The bulk read, the business-key lookups and the normalisers the import
// uses.
func TestCatalogAndLookups(t *testing.T) {
	api := apptest.New(t)
	svc, ctx := service(t, api)
	pt := newType(t, api, "dimmer", schema())
	p := newProduct(t, api, dimmerBody(pt, "M485/GW-ZB.10"))
	v1 := newVariant(t, api, p.ID, variantBody("Ivory White", "27"))
	b := variantBody("Black", "28")
	b["sku"] = "M485 Black"
	v2 := newVariant(t, api, p.ID, b)
	if resp := api.Put("/api/products/"+p.ID+"/variants/"+v1.ID+"/addons", api.Admin.Cookie, map[string]any{
		"addons": []any{map[string]any{"addonVariantId": v2.ID, "required": true}},
	}); resp.Code != http.StatusOK {
		t.Fatalf("add-ons: %d %s", resp.Code, resp.Body)
	}

	catalog, err := svc.Catalog(ctx)
	if err != nil || len(catalog) != 1 || len(catalog[0].Variants) != 2 {
		t.Fatalf("catalog %v %+v", err, catalog)
	}
	if catalog[0].ProductTypeID.String() != pt.ID || catalog[0].CategoryID.String() != pt.CategoryID {
		t.Errorf("type and category %+v", catalog[0])
	}
	cv := catalog[0].Variants[0]
	if cv.ID.String() != v1.ID || len(cv.Addons) != 1 || cv.Addons[0].AddonVariantID.String() != v2.ID || !cv.Addons[0].Required ||
		cv.Price != "27.00" || catalog[0].Attributes["width_te"] != 4.0 {
		t.Errorf("variant %+v", cv)
	}

	if found, ok, err := svc.FindProduct(ctx, "  m485/gw-zb.10 "); err != nil || !ok || found.ID.String() != p.ID {
		t.Errorf("find product: %v %v %+v", err, ok, found)
	}
	if _, ok, err := svc.FindProduct(ctx, "nope"); err != nil || ok {
		t.Errorf("missing product: %v %v", err, ok)
	}
	if found, ok, err := svc.FindVariantBySKU(ctx, "m485 BLACK"); err != nil || !ok || found.ID.String() != v2.ID {
		t.Errorf("find sku: %v %v", err, ok)
	}
	if found, ok, err := svc.FindVariantByName(ctx, uuid.MustParse(p.ID), " ivory white"); err != nil || !ok || found.ID.String() != v1.ID {
		t.Errorf("find name: %v %v", err, ok)
	}
	if products.MatchKey("  MPWS2R1ETH-BP.18  BusPro ") != "mpws2r1eth-bp.18 buspro" {
		t.Error("match key")
	}

	// Normalisers report bare locations with an empty prefix.
	types, _ := producttypes.NewService(api.DB).List(ctx, true)
	cats, _ := categories.NewService(api.DB).List(ctx, true)
	_, errs := products.NormalizeProduct(types[0], cats[0], products.ProductInput{ProductTypeID: types[0].ID, CategoryID: cats[0].ID}, nil, "")
	locations := []string{}
	for _, e := range errs {
		locations = append(locations, e.Location+" "+e.Code)
	}
	if len(locations) != 3 || locations[0] != "modelNumber validation.required" || locations[1] != "name.en validation.required" ||
		locations[2] != "attributes.width_te attribute.required" {
		t.Errorf("locations %v", locations)
	}
	_, errs = products.NormalizeVariant(cats[0], products.VariantInput{Name: i18n.Text{"en": "x"}, Price: "1.234"}, nil, "row")
	if len(errs) != 1 || errs[0].Location != "row.price" {
		t.Errorf("variant errors %+v", errs)
	}

	// SetProductActive checks the version and nothing else.
	if _, err := svc.SetProductActive(ctx, catalog[0].ID, false, time.Now()); code(err) != "product.stale" {
		t.Errorf("stale: %v", err)
	}
	off, err := svc.SetProductActive(ctx, catalog[0].ID, false, catalog[0].UpdatedAt)
	if err != nil || off.IsActive || !off.UpdatedAt.After(catalog[0].UpdatedAt) {
		t.Errorf("deactivate: %v %+v", err, off)
	}
}

// A service working inside an outer transaction: a refused write rolls
// back only its savepoint, the outer transaction goes on, and its rollback
// undoes everything.
func TestWithTxSavepoints(t *testing.T) {
	api := apptest.New(t)
	svc, ctx := service(t, api)
	pt := newType(t, api, "dimmer", schema())
	newProduct(t, api, dimmerBody(pt, "M-1"))
	typeID, categoryID := uuid.MustParse(pt.ID), uuid.MustParse(pt.CategoryID)
	in := func(model string) products.ProductInput {
		return products.ProductInput{ProductTypeID: typeID, CategoryID: categoryID, ModelNumber: model, Name: i18n.Text{"en": model},
			Attributes: map[string]any{"width_te": 2}, IsActive: true}
	}

	tx, err := api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	inTx := svc.WithTx(tx)
	if _, err := inTx.CreateProductRow(ctx, in("m-1"), products.Known{}); code(err) != "product.model_number_taken" {
		t.Fatalf("duplicate: %v", err)
	}
	created, err := inTx.CreateProductRow(ctx, in("M-2"), products.Known{})
	if err != nil {
		t.Fatalf("the outer transaction must still work: %v", err)
	}
	v, err := inTx.CreateVariantRow(ctx, created.ID, products.VariantInput{Name: i18n.Text{"en": "A"}, Price: "1", IsActive: true}, products.Known{})
	if err != nil {
		t.Fatal(err)
	}
	if found, ok, err := inTx.FindVariantByName(ctx, created.ID, "a"); err != nil || !ok || found.ID != v.ID {
		t.Errorf("read inside the transaction: %v %v", err, ok)
	}
	if _, ok, _ := svc.FindProduct(ctx, "M-2"); ok {
		t.Error("uncommitted product visible outside")
	}
	if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	if _, ok, _ := svc.FindProduct(ctx, "M-2"); ok {
		t.Error("rolled back product exists")
	}
}
