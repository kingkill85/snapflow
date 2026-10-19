package products

// What other features (the import first) use to read and write the catalog
// in bulk: exported normalisers that check a product or variant without
// writing, a bulk read of the whole catalog, business-key lookups, and lean
// writes that return the written row instead of the full response. Every
// write still goes through the same validation as the HTTP API, so all
// product rules apply.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
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
	Mounting      string            `json:"mounting,omitempty" doc:"Mounting override; empty = the category's"`
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
	// AddonsUpdatedAt is the version of the add-on list (ReplaceAddons
	// moves it, not UpdatedAt: D56).
	AddonsUpdatedAt time.Time    `json:"addonsUpdatedAt"`
	Addons          []AddonInput `json:"addons,omitempty"`
}

// Known are the product type and category of a lean write that the caller
// has read in the same transaction (an import reads them all once), so the
// write does not read them again. A nil field, or one with another id than
// the input's, is read as usual. For variant writes Category must be the
// product's category.
type Known struct {
	Type     *producttypes.ProductType
	Category *categories.Category
	// NewProduct says the variants' product was created in the same
	// transaction: nobody else sees it, so CreateVariantRows does not lock
	// it first.
	NewProduct bool
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
	if in.Mounting != nil && *in.Mounting != "" && !capabilities.ValidMounting(*in.Mounting) {
		errs = append(errs, apperr.Field(at(prefix, "mounting"), "validation.invalid", "mounting must be floorplan, board or both"))
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
func (s *Service) CreateProductRow(ctx context.Context, in ProductInput, known Known) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	row, err := s.createProduct(ctx, in, known)
	if err != nil {
		return CatalogProduct{}, err
	}
	return catalogProduct(row), nil
}

// UpdateProductRow is Update returning the written row.
func (s *Service) UpdateProductRow(ctx context.Context, id uuid.UUID, in ProductUpdate, known Known) (CatalogProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogProduct{}, err
	}
	row, err := s.updateProduct(ctx, id, in, false, known)
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
			Attributes: p.Attributes, IsActive: p.IsActive, Mounting: &p.Mounting,
		},
		ExpectedUpdatedAt: expectedUpdatedAt,
	}, true, Known{})
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
func (s *Service) CreateVariantRow(ctx context.Context, productID uuid.UUID, in VariantInput, known Known) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	_, row, err := s.createVariant(ctx, productID, in, known)
	if err != nil {
		return CatalogVariant{}, err
	}
	return catalogVariant(row), nil
}

// UpdateVariantRow is UpdateVariant returning the written row.
func (s *Service) UpdateVariantRow(ctx context.Context, productID, id uuid.UUID, in VariantUpdate, known Known) (CatalogVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogVariant{}, err
	}
	_, row, err := s.updateVariant(ctx, productID, id, in, false, known)
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
	}, true, Known{})
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

// CreateVariantRows is CreateVariantRow for several new variants of one
// product, written in one statement in the given order (at the end of the
// product's order). Each is validated like CreateVariant; failed is the
// index of the input that was refused (-1 for an error of the write).
func (s *Service) CreateVariantRows(ctx context.Context, productID uuid.UUID, in []VariantInput, known Known) (created []CatalogVariant, failed int, err error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, -1, err
	}
	c := known.Category
	if c == nil {
		product, err := s.q.GetProduct(ctx, productID)
		if err != nil {
			return nil, -1, notFound(err, "product.not_found")
		}
		cat, err := s.cats.Get(ctx, product.CategoryID)
		if err != nil {
			return nil, -1, err
		}
		c = &cat
	}
	params := store.CreateVariantsParams{ProductID: productID}
	for i := range in {
		v, err := s.validateVariant(ctx, *c, in[i], nil)
		if err != nil {
			return nil, i, err
		}
		name, err := json.Marshal(v.Name)
		if err != nil {
			return nil, i, err
		}
		attrs, err := json.Marshal(v.Attributes)
		if err != nil {
			return nil, i, err
		}
		image := ""
		if v.ImageFileID != nil {
			image = v.ImageFileID.String()
		}
		params.Names, params.Skus, params.Prices = append(params.Names, name), append(params.Skus, v.SKU), append(params.Prices, v.Price)
		params.ImageFileIds, params.Attributes, params.Active = append(params.ImageFileIds, image), append(params.Attributes, attrs), append(params.Active, v.IsActive)
	}
	var rows []store.ProductVariant
	err = s.inTx(ctx, func(q *store.Queries) error {
		if !known.NewProduct {
			if _, err := q.LockProduct(ctx, productID); err != nil {
				return err
			}
		}
		var err error
		rows, err = q.CreateVariants(ctx, params)
		return err
	})
	if err != nil {
		return nil, -1, mapVariantErr(err, VariantInput{}, "product.not_found")
	}
	byName := make(map[string]store.ProductVariant, len(rows))
	for _, r := range rows {
		byName[strings.ToLower(r.Name[i18n.DefaultLocale])] = r
	}
	created = make([]CatalogVariant, len(in))
	for i, v := range in {
		created[i] = catalogVariant(byName[strings.ToLower(strings.TrimSpace(v.Name[i18n.DefaultLocale]))])
	}
	return created, -1, nil
}

// VariantAddons is a variant's new add-on list (SetAddonLists).
type VariantAddons struct {
	ProductID, VariantID uuid.UUID
	Addons               []AddonInput
}

// SetAddonLists is SetAddons for many variants in one transaction and a
// few statements (the same checks and locks, each kind for all lists at
// once). failed is the index of the list that was refused (-1 for an error
// that is not one list's).
func (s *Service) SetAddonLists(ctx context.Context, lists []VariantAddons) (failed int, err error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return -1, err
	}
	if len(lists) == 0 {
		return -1, nil
	}
	productIDs := make([]uuid.UUID, 0, len(lists))
	variantIDs := make([]uuid.UUID, 0, len(lists))
	ofVariant := make([]uuid.UUID, 0, len(lists))
	targets := []uuid.UUID{}
	for i, l := range lists {
		if len(l.Addons) > MaxAddons {
			return i, apperr.Validation(apperr.Field("body.addons", "validation.too_many",
				fmt.Sprintf("at most %d add-ons", MaxAddons)).With("max", MaxAddons))
		}
		productIDs = append(productIDs, l.ProductID)
		variantIDs, ofVariant = append(variantIDs, l.VariantID), append(ofVariant, l.ProductID)
		for _, a := range l.Addons {
			targets = append(targets, a.AddonVariantID)
		}
	}
	failed = -1
	err = s.inTx(ctx, func(q *store.Queries) error {
		failed = -1
		shared, err := q.ShareProducts(ctx, productIDs)
		if err != nil {
			return err
		}
		touched, err := q.TouchVariantsAddons(ctx, store.TouchVariantsAddonsParams{Ids: variantIDs, ProductIds: ofVariant})
		if err != nil {
			return err
		}
		found, err := q.ExistingVariantIDs(ctx, targets)
		if err != nil {
			return err
		}
		has := func(list []uuid.UUID) map[uuid.UUID]bool {
			m := make(map[uuid.UUID]bool, len(list))
			for _, id := range list {
				m[id] = true
			}
			return m
		}
		products, variants, exists := has(shared), has(touched), has(found)
		params := store.InsertAddonListsParams{}
		for i, l := range lists {
			if !products[l.ProductID] || !variants[l.VariantID] {
				failed = i
				return apperr.NotFound("variant.not_found")
			}
			var errs []apperr.FieldError
			seen := map[uuid.UUID]bool{}
			for j, a := range l.Addons {
				loc := fmt.Sprintf("body.addons[%d].addonVariantId", j)
				switch id := a.AddonVariantID; {
				case id == l.VariantID:
					errs = append(errs, apperr.Field(loc, "addon.self", "a variant cannot be its own add-on"))
				case seen[id]:
					errs = append(errs, apperr.Field(loc, "addon.duplicate", "this add-on is listed twice"))
				case !exists[id]:
					errs = append(errs, apperr.Field(loc, "addon.variant_not_found", "no such variant"))
				}
				seen[a.AddonVariantID] = true
				params.VariantIds, params.AddonIds = append(params.VariantIds, l.VariantID), append(params.AddonIds, a.AddonVariantID)
				params.Required, params.SortOrders = append(params.Required, a.Required), append(params.SortOrders, int32(j+1)) //nolint:gosec // at most MaxAddons
			}
			if len(errs) > 0 {
				failed = i
				return apperr.Validation(errs...)
			}
		}
		if err := q.DeleteAddonsOf(ctx, variantIDs); err != nil {
			return err
		}
		return q.InsertAddonLists(ctx, params)
	})
	return failed, err
}

func catalogProduct(r store.Product) CatalogProduct {
	p := CatalogProduct{
		ID: r.ID, ProductTypeID: r.ProductTypeID, CategoryID: r.CategoryID, ModelNumber: r.ModelNumber, Name: r.Name,
		Attributes: r.Attributes, IsActive: r.IsActive, Mounting: deref(r.Mounting), UpdatedAt: r.UpdatedAt,
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
		UpdatedAt: r.UpdatedAt, AddonsUpdatedAt: r.AddonsUpdatedAt,
	}
	if v.Attributes == nil {
		v.Attributes = attrschema.Values{}
	}
	return v
}

// ---------------------------------------------------------------- plans

// PlacementVariant is what a plan needs of a placed variant: where it
// belongs, whether it can still be offered, its add-ons and the instance
// schema of its category.
type PlacementVariant struct {
	ID            uuid.UUID
	ProductID     uuid.UUID
	ProductTypeID uuid.UUID
	CategoryID    uuid.UUID
	// Active flags of the variant, its product, product type and category;
	// the variant is available when all are true (D54).
	VariantActive, ProductActive, TypeActive, CategoryActive bool
	Addons                                                   []PlacementAddon
	InstanceAttributes                                       attrschema.InstanceSchema
}

// Available reports whether the variant can be offered (D54).
func (v PlacementVariant) Available() bool {
	return v.VariantActive && v.ProductActive && v.TypeActive && v.CategoryActive
}

// PlacementAddon is one add-on link of a placed variant.
type PlacementAddon struct {
	AddonVariantID uuid.UUID
	Required       bool
	Available      bool
}

// PlacementVariants returns the variants of ids that exist, by id (ids that
// do not exist are left out). Needs catalog.read.
func (s *Service) PlacementVariants(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]PlacementVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	out := map[uuid.UUID]PlacementVariant{}
	if len(ids) == 0 {
		return out, nil
	}
	cat, err := s.loadCatalog(ctx)
	if err != nil {
		return nil, err
	}
	var (
		rows   []store.VariantFactsRow
		addons []store.ListAddonsRow
	)
	err = s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		if rows, err = q.VariantFacts(ctx, ids); err != nil {
			return err
		}
		addons, err = q.ListAddons(ctx, ids)
		return err
	})
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		pt, err := cat.typeOf(ctx, s, r.ProductTypeID)
		if err != nil {
			return nil, err
		}
		c, err := cat.categoryOf(ctx, s, r.CategoryID)
		if err != nil {
			return nil, err
		}
		out[r.ID] = PlacementVariant{
			ID: r.ID, ProductID: r.ProductID, ProductTypeID: r.ProductTypeID, CategoryID: r.CategoryID,
			VariantActive: r.IsActive, ProductActive: r.ProductIsActive, TypeActive: pt.IsActive, CategoryActive: c.IsActive,
			InstanceAttributes: c.InstanceAttributes,
		}
	}
	for _, a := range addons {
		v, ok := out[a.VariantID]
		if !ok {
			continue
		}
		pt, err := cat.typeOf(ctx, s, a.ProductTypeID)
		if err != nil {
			return nil, err
		}
		c, err := cat.categoryOf(ctx, s, a.CategoryID)
		if err != nil {
			return nil, err
		}
		v.Addons = append(v.Addons, PlacementAddon{
			AddonVariantID: a.AddonVariantID, Required: a.Required,
			Available: a.IsActive && a.ProductIsActive && pt.IsActive && c.IsActive,
		})
		out[a.VariantID] = v
	}
	return out, nil
}
