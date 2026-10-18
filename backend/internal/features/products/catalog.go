package products

// What other features (the import first) use to read and write the catalog
// in bulk: exported normalisers that check a product or variant without
// writing, a bulk read of the whole catalog, business-key lookups, and lean
// writes that return the written row instead of the full response. Every
// write still goes through the same validation as the HTTP API, so all
// product rules apply.

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products/store"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// CatalogProduct is a product as stored, with its variants (in variant
// order) and their add-ons: the bulk read for imports and their change log.
type CatalogProduct struct {
	ID            uuid.UUID         `json:"id"`
	ProductTypeID uuid.UUID         `json:"productTypeId"`
	CategoryID    uuid.UUID         `json:"categoryId"`
	ModelNumber   string            `json:"modelNumber"`
	Name          i18n.Text         `json:"name"`
	Description   i18n.Text         `json:"description,omitempty"`
	Attributes    attrschema.Values `json:"attributes"`
	IsActive      bool              `json:"isActive"`
	UpdatedAt     time.Time         `json:"updatedAt"`
	Variants      []CatalogVariant  `json:"variants,omitempty"`
}

// CatalogVariant is a variant as stored, with its add-ons in order.
type CatalogVariant struct {
	ID          uuid.UUID         `json:"id"`
	ProductID   uuid.UUID         `json:"productId"`
	Name        i18n.Text         `json:"name"`
	SKU         string            `json:"sku,omitempty"`
	Price       string            `json:"price"`
	ImageFileID *uuid.UUID        `json:"imageFileId,omitempty"`
	Attributes  attrschema.Values `json:"attributes"`
	SortOrder   int32             `json:"sortOrder"`
	IsActive    bool              `json:"isActive"`
	UpdatedAt   time.Time         `json:"updatedAt"`
	Addons      []AddonInput      `json:"addons,omitempty"`
}

// Existing describes the stored product a save changes (nil for a create).
type Existing struct {
	ProductTypeID uuid.UUID
	CategoryID    uuid.UUID
	Attributes    attrschema.Values
}

// ---------------------------------------------------------------- normalise

// NormalizeProduct trims, normalises and checks a product of type pt in
// category c (whose schema its values follow) without writing anything, and
// returns every problem. Errors are located at prefix + "." + field
// ("body.modelNumber" for the API); an empty prefix gives bare field paths
// ("modelNumber", "attributes.width_te"), which the import maps to its
// columns. Attribute values follow D31/D55: keys the schema lacks are kept
// only if existing has them (stored value untouched).
func NormalizeProduct(pt producttypes.ProductType, c categories.Category, in ProductInput, existing *Existing, prefix string) (ProductInput, []apperr.FieldError) {
	return normalizeProduct(&pt, &c, in, existing, prefix)
}

// normalizeProduct is NormalizeProduct; a nil type or category is reported
// as not found (without a category the attributes are not checked: there is
// no schema to check them against).
func normalizeProduct(pt *producttypes.ProductType, c *categories.Category, in ProductInput, existing *Existing, prefix string) (ProductInput, []apperr.FieldError) {
	errs := []apperr.FieldError{}
	in.ModelNumber = businessKey(in.ModelNumber)
	switch {
	case in.ModelNumber == "":
		errs = append(errs, apperr.Field(at(prefix, "modelNumber"), "validation.required", "model number is required"))
	case hasControlChars(in.ModelNumber):
		errs = append(errs, errControlChars(at(prefix, "modelNumber")))
	case utf8.RuneCountInString(in.ModelNumber) > MaxModelNumberLength:
		errs = append(errs, tooLong(at(prefix, "modelNumber"), MaxModelNumberLength))
	}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check(at(prefix, "name"), MaxNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field(at(prefix, "name.en"), "validation.required", "English name is required"))
	}
	in.Description = in.Description.Trimmed()
	errs = append(errs, in.Description.Check(at(prefix, "description"), MaxDescriptionLength)...)
	if len(in.Description) > 0 && !in.Description.Valid() {
		errs = append(errs, apperr.Field(at(prefix, "description.en"), "validation.required", "English description is required when a description is set"))
	}
	switch {
	case pt == nil:
		errs = append(errs, apperr.Field(at(prefix, "productTypeId"), "product.type_not_found", "no such product type"))
	case !pt.IsActive && (existing == nil || existing.ProductTypeID != pt.ID):
		// An inactive type takes no new products; a product keeps its own.
		errs = append(errs, apperr.Field(at(prefix, "productTypeId"), "product.type_inactive", "the product type is inactive"))
	}
	if c == nil {
		return in, append(errs, apperr.Field(at(prefix, "categoryId"), "product.category_not_found", "no such category"))
	}
	// An inactive category takes no new products; a product keeps its own.
	if !c.IsActive && (existing == nil || existing.CategoryID != c.ID) {
		errs = append(errs, apperr.Field(at(prefix, "categoryId"), "product.category_inactive", "the category is inactive"))
	}
	var previous attrschema.Values
	if existing != nil {
		previous = existing.Attributes
	}
	var attrErrs []apperr.FieldError
	in.Attributes, attrErrs = saveValues(c.Attributes, attrschema.ScopeProduct, in.Attributes, previous, at(prefix, "attributes"))
	return in, append(errs, attrErrs...)
}

// NormalizeVariant is NormalizeProduct for a variant of a product in
// category c; previous are its stored values (nil for a create). The image
// is not checked (the caller's save does that).
func NormalizeVariant(c categories.Category, in VariantInput, previous attrschema.Values, prefix string) (VariantInput, []apperr.FieldError) {
	errs := []apperr.FieldError{}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check(at(prefix, "name"), MaxVariantNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field(at(prefix, "name.en"), "validation.required", "English name is required"))
	}
	in.SKU = businessKey(in.SKU)
	switch {
	case hasControlChars(in.SKU):
		errs = append(errs, errControlChars(at(prefix, "sku")))
	case utf8.RuneCountInString(in.SKU) > MaxSKULength:
		errs = append(errs, tooLong(at(prefix, "sku"), MaxSKULength))
	}
	if price, ok := parsePrice(in.Price); ok {
		in.Price = price
	} else {
		errs = append(errs, apperr.Field(at(prefix, "price"), "variant.price_format",
			"price must be a decimal with up to 10 digits and 2 decimals, e.g. 27.00"))
	}
	var attrErrs []apperr.FieldError
	in.Attributes, attrErrs = saveValues(c.Attributes, attrschema.ScopeVariant, in.Attributes, previous, at(prefix, "attributes"))
	return in, append(errs, attrErrs...)
}

// BusinessKey normalises a model number or SKU as stored: Unicode NFC,
// trimmed (D77).
func BusinessKey(s string) string { return businessKey(s) }

// MatchKey is how the import matches model numbers, SKUs and add-on
// references: NFC, whitespace runs collapsed to one space, trimmed, lower
// case. Two keys with the same MatchKey are the same item.
func MatchKey(s string) string {
	return strings.ToLower(CollapseSpace(norm.NFC.String(s)))
}

// CollapseSpace trims s and replaces every run of white space by one space.
func CollapseSpace(s string) string {
	return strings.Join(strings.FieldsFunc(s, unicode.IsSpace), " ")
}

func at(prefix, field string) string {
	if prefix == "" {
		return field
	}
	return prefix + "." + field
}

// ---------------------------------------------------------------- bulk read

// Catalog returns every product (active or not, any type or category) with its variants
// and their add-ons, ordered by model number; three queries, no page cap.
func (s *Service) Catalog(ctx context.Context) ([]CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	var (
		products []store.Product
		variants []store.ProductVariant
		addons   []store.VariantAddon
	)
	err := s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		if products, err = q.CatalogProducts(ctx); err != nil {
			return err
		}
		if variants, err = q.CatalogVariants(ctx); err != nil {
			return err
		}
		addons, err = q.CatalogAddons(ctx)
		return err
	})
	if err != nil {
		return nil, err
	}
	byVariant := map[uuid.UUID][]AddonInput{}
	for _, a := range addons {
		byVariant[a.VariantID] = append(byVariant[a.VariantID], AddonInput{AddonVariantID: a.AddonVariantID, Required: a.Required})
	}
	byProduct := map[uuid.UUID][]CatalogVariant{}
	for _, v := range variants {
		cv := catalogVariant(v)
		cv.Addons = byVariant[v.ID]
		byProduct[v.ProductID] = append(byProduct[v.ProductID], cv)
	}
	out := make([]CatalogProduct, len(products))
	for i, p := range products {
		out[i] = catalogProduct(p)
		out[i].Variants = byProduct[p.ID]
	}
	return out, nil
}

// FindProduct returns the product with the model number (compared as
// stored: NFC, trimmed, ignoring case), without variants; found is false if
// there is none.
func (s *Service) FindProduct(ctx context.Context, modelNumber string) (p CatalogProduct, found bool, err error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return p, false, err
	}
	row, err := s.q.FindProductByModelNumber(ctx, businessKey(modelNumber))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, false, nil
	}
	if err != nil {
		return p, false, err
	}
	return catalogProduct(row), true, nil
}

// FindVariantBySKU returns the variant with the SKU (NFC, trimmed, ignoring
// case), without add-ons.
func (s *Service) FindVariantBySKU(ctx context.Context, sku string) (v CatalogVariant, found bool, err error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return v, false, err
	}
	return foundVariant(s.q.FindVariantBySKU(ctx, businessKey(sku)))
}

// FindVariantByName returns the product's variant with the English name
// (trimmed, ignoring case), without add-ons.
func (s *Service) FindVariantByName(ctx context.Context, productID uuid.UUID, name string) (v CatalogVariant, found bool, err error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return v, false, err
	}
	return foundVariant(s.q.FindVariantByName(ctx, store.FindVariantByNameParams{ProductID: productID, Name: strings.TrimSpace(name)}))
}

func foundVariant(row store.ProductVariant, err error) (CatalogVariant, bool, error) {
	if errors.Is(err, pgx.ErrNoRows) {
		return CatalogVariant{}, false, nil
	}
	if err != nil {
		return CatalogVariant{}, false, err
	}
	return catalogVariant(row), true, nil
}

// ---------------------------------------------------------------- lean writes

// CreateProductRow is Create returning the written row (no variants)
// instead of the full response.
func (s *Service) CreateProductRow(ctx context.Context, in ProductInput) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	row, err := s.createProduct(ctx, in)
	if err != nil {
		return CatalogProduct{}, err
	}
	return catalogProduct(row), nil
}

// UpdateProductRow is Update returning the written row.
func (s *Service) UpdateProductRow(ctx context.Context, id uuid.UUID, in ProductUpdate) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	row, err := s.updateProduct(ctx, id, in, false)
	if err != nil {
		return CatalogProduct{}, err
	}
	return catalogProduct(row), nil
}

// RestoreProduct writes p's own fields back as they are, without
// validating its values against the current schema, if the product is
// still at expectedUpdatedAt (product.stale otherwise). Undoing an import
// uses it: p is a state that existed, and a schema changed since must not
// make the undo impossible (D26: problems are flagged on read). Unique
// model numbers are still enforced.
func (s *Service) RestoreProduct(ctx context.Context, p CatalogProduct, expectedUpdatedAt time.Time) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	row, err := s.updateProduct(ctx, p.ID, ProductUpdate{
		ProductInput: ProductInput{
			ProductTypeID: p.ProductTypeID, CategoryID: p.CategoryID, ModelNumber: p.ModelNumber, Name: p.Name, Description: p.Description,
			Attributes: p.Attributes, IsActive: p.IsActive,
		},
		ExpectedUpdatedAt: expectedUpdatedAt,
	}, true)
	if err != nil {
		return CatalogProduct{}, err
	}
	return catalogProduct(row), nil
}

// SetProductActive changes only a product's active flag, if it is still at
// expectedUpdatedAt (product.stale otherwise). Its values are not
// re-validated: deactivating a product whose values no longer match the
// schema must work.
func (s *Service) SetProductActive(ctx context.Context, id uuid.UUID, active bool, expectedUpdatedAt time.Time) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	var row store.Product
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.SetProductActive(ctx, store.SetProductActiveParams{ID: id, IsActive: active, ExpectedUpdatedAt: expectedUpdatedAt})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CatalogProduct{}, s.productGoneOrStale(ctx, id)
	}
	if err != nil {
		return CatalogProduct{}, err
	}
	return catalogProduct(row), nil
}

// CreateVariantRow is CreateVariant returning the written row.
func (s *Service) CreateVariantRow(ctx context.Context, productID uuid.UUID, in VariantInput) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	_, row, err := s.createVariant(ctx, productID, in)
	if err != nil {
		return CatalogVariant{}, err
	}
	return catalogVariant(row), nil
}

// UpdateVariantRow is UpdateVariant returning the written row.
func (s *Service) UpdateVariantRow(ctx context.Context, productID, id uuid.UUID, in VariantUpdate) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	_, row, err := s.updateVariant(ctx, productID, id, in, false)
	if err != nil {
		return CatalogVariant{}, err
	}
	return catalogVariant(row), nil
}

// RestoreVariant is RestoreProduct for a variant's own fields (not its
// add-ons or position).
func (s *Service) RestoreVariant(ctx context.Context, v CatalogVariant, expectedUpdatedAt time.Time) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	_, row, err := s.updateVariant(ctx, v.ProductID, v.ID, VariantUpdate{
		VariantInput: VariantInput{
			Name: v.Name, SKU: v.SKU, Price: v.Price, ImageFileID: v.ImageFileID, Attributes: v.Attributes, IsActive: v.IsActive,
		},
		ExpectedUpdatedAt: expectedUpdatedAt,
	}, true)
	if err != nil {
		return CatalogVariant{}, err
	}
	return catalogVariant(row), nil
}

// SetVariantActive changes only a variant's active flag (see
// SetProductActive).
func (s *Service) SetVariantActive(ctx context.Context, productID, id uuid.UUID, active bool, expectedUpdatedAt time.Time) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	var row store.ProductVariant
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.SetVariantActive(ctx, store.SetVariantActiveParams{ID: id, ProductID: productID, IsActive: active, ExpectedUpdatedAt: expectedUpdatedAt})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CatalogVariant{}, s.variantGoneOrStale(ctx, productID, id)
	}
	if err != nil {
		return CatalogVariant{}, err
	}
	return catalogVariant(row), nil
}

// SetAddons is ReplaceAddons without building the response.
func (s *Service) SetAddons(ctx context.Context, productID, variantID uuid.UUID, list []AddonInput) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.replaceAddons(ctx, productID, variantID, list)
}

func catalogProduct(r store.Product) CatalogProduct {
	p := CatalogProduct{
		ID: r.ID, ProductTypeID: r.ProductTypeID, CategoryID: r.CategoryID, ModelNumber: r.ModelNumber, Name: r.Name,
		Attributes: r.Attributes, IsActive: r.IsActive, UpdatedAt: r.UpdatedAt,
	}
	if r.Description != nil {
		p.Description = *r.Description
	}
	if p.Attributes == nil {
		p.Attributes = attrschema.Values{}
	}
	return p
}

func catalogVariant(r store.ProductVariant) CatalogVariant {
	v := CatalogVariant{
		ID: r.ID, ProductID: r.ProductID, Name: r.Name, SKU: deref(r.Sku), Price: formatPrice(r.Price),
		ImageFileID: r.ImageFileID, Attributes: r.Attributes, SortOrder: r.SortOrder, IsActive: r.IsActive,
		UpdatedAt: r.UpdatedAt,
	}
	if v.Attributes == nil {
		v.Attributes = attrschema.Values{}
	}
	return v
}
