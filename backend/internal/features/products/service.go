// Package products manages the products of the global catalog with their
// variants and add-ons (one aggregate). A product belongs to a product type
// whose attribute schema its values follow; variants carry the price and
// image; add-ons link a variant to variants that go with it. Reads need
// catalog.read, writes catalog.write.
//
// Product types are read through producttypes.Service and files are checked
// through files.Service; this feature never reads their tables.
package products

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/products/store"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Limits.
const (
	MaxModelNumberLength = 100
	MaxNameLength        = 200
	MaxDescriptionLength = 5000
	MaxVariantNameLength = 100
	MaxSKULength         = 100
	MaxAddons            = 100
	MaxPageSize          = 200
	DefaultPageSize      = 50
	MaxSearchLength      = 200
)

// pricePattern is the accepted money format: up to 10 digits before the
// point and up to 2 after (numeric(12,2)); no sign, exponent or bare point.
var pricePattern = regexp.MustCompile(`^\d{1,10}(\.\d{1,2})?$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db    DB
	q     *store.Queries
	types *producttypes.Service
	files *files.Service
}

func NewService(db DB, types *producttypes.Service, files *files.Service) *Service {
	return &Service{db: db, q: store.New(db), types: types, files: files}
}

// inSnapshot runs the reads of fn in one read-only REPEATABLE READ
// transaction, so they see one state of the database.
func (s *Service) inSnapshot(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// inTx runs fn in one transaction; any error rolls it back. A transaction
// aborted by a deadlock or serialization failure is run again (at most
// database.TxAttempts times, then 409 request.conflict_retry), so fn must be
// safe to repeat.
func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- products

// List returns one page of products in catalog order (product type order,
// then model number). Without IncludeInactive only active products of
// active types are listed.
func (s *Service) List(ctx context.Context, p ListParams) (ProductPage, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return ProductPage{}, err
	}
	if err := checkPage(p.Limit, p.Offset); err != nil {
		return ProductPage{}, err
	}
	types, err := s.loadTypes(ctx)
	if err != nil {
		return ProductPage{}, err
	}
	pattern := likePattern(p.Search)
	var (
		rows     []store.Product
		total    int64
		variants []store.ProductVariant
	)
	// One snapshot: the page, its total and its variants agree.
	err = s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		rows, err = q.ListProducts(ctx, store.ListProductsParams{
			TypeIds: types.order, ProductTypeID: p.ProductTypeID, IncludeInactive: p.IncludeInactive,
			InactiveTypeIds: types.inactive, Search: pattern,
			RowLimit: int32(p.Limit), RowOffset: int32(p.Offset), //nolint:gosec // checked by checkPage
		})
		if err != nil {
			return err
		}
		total, err = q.CountProducts(ctx, store.CountProductsParams{
			ProductTypeID: p.ProductTypeID, IncludeInactive: p.IncludeInactive,
			InactiveTypeIds: types.inactive, Search: pattern,
		})
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, r := range rows {
			ids[i] = r.ID
		}
		variants, err = q.ListVariantsOfProducts(ctx, ids)
		return err
	})
	if err != nil {
		return ProductPage{}, err
	}
	byProduct := map[uuid.UUID][]store.ProductVariant{}
	for _, v := range variants {
		byProduct[v.ProductID] = append(byProduct[v.ProductID], v)
	}

	write := actor.Can(auth.PermCatalogWrite)
	items := make([]ProductListItem, 0, len(rows))
	for _, r := range rows {
		pt, err := types.get(ctx, s.types, r.ProductTypeID)
		if err != nil {
			return ProductPage{}, err
		}
		item := ProductListItem{
			ID: r.ID, ProductTypeID: r.ProductTypeID, ProductType: typeRef(pt), ModelNumber: r.ModelNumber,
			Name: r.Name, IsActive: r.IsActive, Available: r.IsActive && pt.IsActive,
			Can: auth.Actions{Update: write, Delete: write},
		}
		_, stale, errs := readValues(pt.Attributes, attrschema.ScopeProduct, r.Attributes)
		item.AttributeErrors, item.StaleAttributes = len(errs), len(stale)
		var lo, hi *big.Rat
		for _, v := range byProduct[r.ID] {
			item.VariantCount++
			_, stale, errs := readValues(pt.Attributes, attrschema.ScopeVariant, v.Attributes)
			item.AttributeErrors += len(errs)
			item.StaleAttributes += len(stale)
			if !v.IsActive {
				continue
			}
			if item.PreviewImageFileID == nil && v.ImageFileID != nil {
				item.PreviewImageFileID = v.ImageFileID
			}
			if price, ok := new(big.Rat).SetString(v.Price); ok {
				if lo == nil || price.Cmp(lo) < 0 {
					lo = price
				}
				if hi == nil || price.Cmp(hi) > 0 {
					hi = price
				}
			}
		}
		if lo != nil {
			item.PriceMin, item.PriceMax = lo.FloatString(2), hi.FloatString(2)
		}
		items = append(items, item)
	}
	return ProductPage{Items: items, Total: total}, nil
}

// Get returns a product with its variants and their add-ons.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Product, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return Product{}, err
	}
	row, err := s.q.GetProduct(ctx, id)
	if err != nil {
		return Product{}, notFound(err, "product.not_found")
	}
	return s.detail(ctx, actor, row)
}

// Create adds a product (without variants).
func (s *Service) Create(ctx context.Context, in ProductInput) (Product, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Product{}, err
	}
	in, err = s.validateProduct(ctx, in, nil)
	if err != nil {
		return Product{}, err
	}
	var row store.Product
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.CreateProduct(ctx, store.CreateProductParams{
			ProductTypeID: in.ProductTypeID, ModelNumber: in.ModelNumber, Name: in.Name,
			Description: textPtr(in.Description), Attributes: in.Attributes, IsActive: in.IsActive,
		})
		return err
	})
	if err != nil {
		return Product{}, mapProductErr(err, in.ModelNumber)
	}
	return s.detail(ctx, actor, row)
}

// Update replaces a product's own fields (not its variants). It fails with
// product.stale if the product changed since in.ExpectedUpdatedAt. Values
// whose key the (new) type's schema does not have are kept only if they
// were stored before and are sent back. The type may change, also to one
// whose schema the variants' values do not match: those are only flagged on
// read (Product.VariantsWithProblems), never re-validated or refused.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in ProductUpdate) (Product, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Product{}, err
	}
	current, err := s.q.GetProduct(ctx, id)
	if err != nil {
		return Product{}, notFound(err, "product.not_found")
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return Product{}, errProductStale()
	}
	in.ProductInput, err = s.validateProduct(ctx, in.ProductInput, &current)
	if err != nil {
		return Product{}, err
	}
	var row store.Product
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateProduct(ctx, store.UpdateProductParams{
			ID: id, ProductTypeID: in.ProductTypeID, ModelNumber: in.ModelNumber, Name: in.Name,
			Description: textPtr(in.Description), Attributes: in.Attributes, IsActive: in.IsActive,
			ExpectedUpdatedAt: in.ExpectedUpdatedAt,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, err := s.q.ProductExists(ctx, id)
		if err != nil {
			return Product{}, err
		}
		if exists {
			return Product{}, errProductStale()
		}
		return Product{}, apperr.NotFound("product.not_found")
	}
	if err != nil {
		return Product{}, mapProductErr(err, in.ModelNumber)
	}
	return s.detail(ctx, actor, row)
}

// Delete removes a product with its variants and their add-on links (in
// both directions).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.inTx(ctx, func(q *store.Queries) error {
		n, err := q.DeleteProduct(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return apperr.NotFound("product.not_found")
		}
		return nil
	})
}

// validateProduct checks a create (current nil) or an update of current.
func (s *Service) validateProduct(ctx context.Context, in ProductInput, current *store.Product) (ProductInput, error) {
	var errs []apperr.FieldError
	var previous attrschema.Values
	if current != nil {
		previous = current.Attributes
	}
	in.ModelNumber = businessKey(in.ModelNumber)
	switch {
	case in.ModelNumber == "":
		errs = append(errs, apperr.Field("body.modelNumber", "validation.required", "model number is required"))
	case hasControlChars(in.ModelNumber):
		errs = append(errs, errControlChars("body.modelNumber"))
	case utf8.RuneCountInString(in.ModelNumber) > MaxModelNumberLength:
		errs = append(errs, tooLong("body.modelNumber", MaxModelNumberLength))
	}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check("body.name", MaxNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field("body.name.en", "validation.required", "English name is required"))
	}
	in.Description = in.Description.Trimmed()
	errs = append(errs, in.Description.Check("body.description", MaxDescriptionLength)...)
	if len(in.Description) > 0 && !in.Description.Valid() {
		errs = append(errs, apperr.Field("body.description.en", "validation.required", "English description is required when a description is set"))
	}
	pt, err := s.types.Get(ctx, in.ProductTypeID)
	switch {
	case hasCode(err, "product_type.not_found"):
		errs = append(errs, errTypeNotFound())
	case err != nil:
		return in, err
	default:
		// An inactive type takes no new products; a product keeps its own.
		if !pt.IsActive && (current == nil || current.ProductTypeID != pt.ID) {
			errs = append(errs, apperr.Field("body.productTypeId", "product.type_inactive", "the product type is inactive"))
		}
		var attrErrs []apperr.FieldError
		in.Attributes, attrErrs = saveValues(pt.Attributes, attrschema.ScopeProduct, in.Attributes, previous, "body.attributes")
		errs = append(errs, attrErrs...)
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// detail reads a product's variants and add-ons and builds the response.
func (s *Service) detail(ctx context.Context, actor auth.Actor, row store.Product) (Product, error) {
	types, err := s.loadTypes(ctx)
	if err != nil {
		return Product{}, err
	}
	pt, err := types.get(ctx, s.types, row.ProductTypeID)
	if err != nil {
		return Product{}, err
	}
	variants, err := s.q.ListVariants(ctx, row.ID)
	if err != nil {
		return Product{}, err
	}
	ids := make([]uuid.UUID, len(variants))
	for i, v := range variants {
		ids[i] = v.ID
	}
	addons, err := s.addons(ctx, types, ids)
	if err != nil {
		return Product{}, err
	}
	write := actor.Can(auth.PermCatalogWrite)
	p := Product{
		ID: row.ID, ProductTypeID: row.ProductTypeID, ProductType: typeRef(pt), ModelNumber: row.ModelNumber,
		Name: row.Name, IsActive: row.IsActive, Available: row.IsActive && pt.IsActive,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Can: auth.Actions{Update: write, Delete: write},
	}
	if row.Description != nil {
		p.Description = *row.Description
	}
	p.Attributes, p.StaleAttributes, p.AttributeErrors = readValues(pt.Attributes, attrschema.ScopeProduct, row.Attributes)
	p.Variants = make([]Variant, len(variants))
	for i, v := range variants {
		p.Variants[i] = variantOut(actor, v, pt, p.Available, addons[v.ID])
		if len(p.Variants[i].AttributeErrors) > 0 || len(p.Variants[i].StaleAttributes) > 0 {
			p.VariantsWithProblems++
		}
	}
	return p, nil
}

// ---------------------------------------------------------------- variants

// CreateVariant adds a variant at the end of the product's variants.
func (s *Service) CreateVariant(ctx context.Context, productID uuid.UUID, in VariantInput) (Variant, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Variant{}, err
	}
	product, err := s.q.GetProduct(ctx, productID)
	if err != nil {
		return Variant{}, notFound(err, "product.not_found")
	}
	pt, err := s.types.Get(ctx, product.ProductTypeID)
	if err != nil {
		return Variant{}, err
	}
	in, err = s.validateVariant(ctx, pt, in, nil)
	if err != nil {
		return Variant{}, err
	}
	var row store.ProductVariant
	err = s.inTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockProduct(ctx, productID); err != nil {
			return err
		}
		row, err = q.CreateVariant(ctx, store.CreateVariantParams{
			ProductID: productID, Name: in.Name, Sku: strPtr(in.SKU), Price: in.Price,
			ImageFileID: in.ImageFileID, Attributes: in.Attributes, IsActive: in.IsActive,
		})
		return err
	})
	if err != nil {
		return Variant{}, mapVariantErr(err, in, "product.not_found")
	}
	return s.variantDetail(ctx, actor, product, pt, row)
}

// UpdateVariant replaces a variant (not its add-ons). It fails with
// variant.stale if the variant changed since in.ExpectedUpdatedAt.
func (s *Service) UpdateVariant(ctx context.Context, productID, id uuid.UUID, in VariantUpdate) (Variant, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Variant{}, err
	}
	current, err := s.q.GetVariant(ctx, store.GetVariantParams{ID: id, ProductID: productID})
	if err != nil {
		return Variant{}, notFound(err, "variant.not_found")
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return Variant{}, errVariantStale()
	}
	product, err := s.q.GetProduct(ctx, productID)
	if err != nil {
		return Variant{}, notFound(err, "variant.not_found")
	}
	pt, err := s.types.Get(ctx, product.ProductTypeID)
	if err != nil {
		return Variant{}, err
	}
	in.VariantInput, err = s.validateVariant(ctx, pt, in.VariantInput, current.Attributes)
	if err != nil {
		return Variant{}, err
	}
	var row store.ProductVariant
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateVariant(ctx, store.UpdateVariantParams{
			ID: id, ProductID: productID, Name: in.Name, Sku: strPtr(in.SKU), Price: in.Price,
			ImageFileID: in.ImageFileID, Attributes: in.Attributes, IsActive: in.IsActive,
			ExpectedUpdatedAt: in.ExpectedUpdatedAt,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, err := s.q.VariantExists(ctx, store.VariantExistsParams{ID: id, ProductID: productID})
		if err != nil {
			return Variant{}, err
		}
		if exists {
			return Variant{}, errVariantStale()
		}
		return Variant{}, apperr.NotFound("variant.not_found")
	}
	if err != nil {
		return Variant{}, mapVariantErr(err, in.VariantInput, "variant.not_found")
	}
	return s.variantDetail(ctx, actor, product, pt, row)
}

// DeleteVariant removes a variant and its add-on links in both directions.
func (s *Service) DeleteVariant(ctx context.Context, productID, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.inTx(ctx, func(q *store.Queries) error {
		n, err := q.DeleteVariant(ctx, store.DeleteVariantParams{ID: id, ProductID: productID})
		if err != nil {
			return err
		}
		if n == 0 {
			return apperr.NotFound("variant.not_found")
		}
		return nil
	})
}

// ReorderVariants sets the order of a product's variants. ids must list
// every variant of the product exactly once. It locks the product (FOR
// UPDATE, serialising reorders and creates), then its variants FOR NO KEY
// UPDATE (no delete or update of them meanwhile, yet no wait for add-on
// replaces' KEY SHARE locks).
func (s *Service) ReorderVariants(ctx context.Context, productID uuid.UUID, ids []uuid.UUID) (Product, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Product{}, err
	}
	err = s.inTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockProduct(ctx, productID); err != nil {
			return notFound(err, "product.not_found")
		}
		existing, err := q.LockVariantIDs(ctx, productID)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, "variant.order_mismatch",
				"ids must list every variant of the product exactly once")
		}
		return q.SetVariantOrder(ctx, ids)
	})
	if err != nil {
		return Product{}, err
	}
	row, err := s.q.GetProduct(ctx, productID)
	if err != nil {
		return Product{}, notFound(err, "product.not_found")
	}
	return s.detail(ctx, actor, row)
}

func (s *Service) validateVariant(ctx context.Context, pt producttypes.ProductType, in VariantInput, previous attrschema.Values) (VariantInput, error) {
	var errs []apperr.FieldError
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check("body.name", MaxVariantNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field("body.name.en", "validation.required", "English name is required"))
	}
	in.SKU = businessKey(in.SKU)
	switch {
	case hasControlChars(in.SKU):
		errs = append(errs, errControlChars("body.sku"))
	case utf8.RuneCountInString(in.SKU) > MaxSKULength:
		errs = append(errs, tooLong("body.sku", MaxSKULength))
	}
	if price, ok := parsePrice(in.Price); ok {
		in.Price = price
	} else {
		errs = append(errs, apperr.Field("body.price", "variant.price_format",
			"price must be a decimal with up to 10 digits and 2 decimals, e.g. 27.00"))
	}
	if in.ImageFileID != nil {
		exists, err := s.files.Exists(ctx, *in.ImageFileID)
		if err != nil {
			return in, err
		}
		if !exists {
			errs = append(errs, errFileNotFound())
		}
	}
	var attrErrs []apperr.FieldError
	in.Attributes, attrErrs = saveValues(pt.Attributes, attrschema.ScopeVariant, in.Attributes, previous, "body.attributes")
	errs = append(errs, attrErrs...)
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// variantDetail builds the response of a single variant.
func (s *Service) variantDetail(ctx context.Context, actor auth.Actor, product store.Product, pt producttypes.ProductType, v store.ProductVariant) (Variant, error) {
	types, err := s.loadTypes(ctx)
	if err != nil {
		return Variant{}, err
	}
	addons, err := s.addons(ctx, types, []uuid.UUID{v.ID})
	if err != nil {
		return Variant{}, err
	}
	return variantOut(actor, v, pt, product.IsActive && pt.IsActive, addons[v.ID]), nil
}

// SearchVariants lists variants across the catalog (add-on picker) in
// catalog order: product type, model number, variant order. Without a
// search it lists every variant (browsing); productTypeID narrows it to one
// type.
func (s *Service) SearchVariants(ctx context.Context, p VariantSearchParams) (VariantPage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return VariantPage{}, err
	}
	if err := checkPage(p.Limit, p.Offset); err != nil {
		return VariantPage{}, err
	}
	types, err := s.loadTypes(ctx)
	if err != nil {
		return VariantPage{}, err
	}
	pattern := likePattern(p.Search)
	var (
		rows  []store.SearchVariantsRow
		total int64
	)
	err = s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		rows, err = q.SearchVariants(ctx, store.SearchVariantsParams{
			TypeIds: types.order, ProductTypeID: p.ProductTypeID, Search: pattern,
			RowLimit: int32(p.Limit), RowOffset: int32(p.Offset), //nolint:gosec // checked by checkPage
		})
		if err != nil {
			return err
		}
		total, err = q.CountVariants(ctx, store.CountVariantsParams{ProductTypeID: p.ProductTypeID, Search: pattern})
		return err
	})
	if err != nil {
		return VariantPage{}, err
	}
	items := make([]VariantSearchItem, len(rows))
	for i, r := range rows {
		pt, err := types.get(ctx, s.types, r.ProductTypeID)
		if err != nil {
			return VariantPage{}, err
		}
		items[i] = VariantSearchItem{
			ID: r.ID, ProductID: r.ProductID, ProductTypeID: r.ProductTypeID, ProductType: typeRef(pt),
			ModelNumber: r.ModelNumber, ProductName: r.ProductName, Name: r.Name, SKU: deref(r.Sku),
			Price: formatPrice(r.Price), ImageFileID: r.ImageFileID,
			Available: r.IsActive && r.ProductIsActive && pt.IsActive,
		}
	}
	return VariantPage{Items: items, Total: total}, nil
}

// ---------------------------------------------------------------- add-ons

// ReplaceAddons replaces a variant's add-ons with list (in list order) in
// one transaction. Every add-on must exist, differ from the variant and
// appear once; all problems are reported together. Cycles are allowed.
//
// Lock order: the product (KEY SHARE, like LockProduct's callers take the
// product first), the variant (NO KEY UPDATE), then the add-on variants (KEY
// SHARE, in id order). Replaces never wait for each other's add-on locks, and
// reorders and creates wait at the product. A product or variant delete
// locks the add-on variants it removes in its own order, so a deadlock with a
// concurrent replace is possible; inTx runs the loser again.
func (s *Service) ReplaceAddons(ctx context.Context, productID, variantID uuid.UUID, list []AddonInput) (Variant, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Variant{}, err
	}
	if len(list) > MaxAddons {
		return Variant{}, apperr.Validation(apperr.Field("body.addons", "validation.too_many",
			fmt.Sprintf("at most %d add-ons", MaxAddons)).With("max", MaxAddons))
	}
	err = s.inTx(ctx, func(q *store.Queries) error {
		if _, err := q.ShareProduct(ctx, productID); err != nil {
			return notFound(err, "variant.not_found")
		}
		if _, err := q.LockVariantForAddons(ctx, store.LockVariantForAddonsParams{ID: variantID, ProductID: productID}); err != nil {
			return notFound(err, "variant.not_found")
		}
		ids := make([]uuid.UUID, len(list))
		required := make([]bool, len(list))
		for i, a := range list {
			ids[i], required[i] = a.AddonVariantID, a.Required
		}
		found, err := q.ExistingVariantIDs(ctx, ids)
		if err != nil {
			return err
		}
		exists := make(map[uuid.UUID]bool, len(found))
		for _, id := range found {
			exists[id] = true
		}
		var errs []apperr.FieldError
		seen := map[uuid.UUID]bool{}
		for i, id := range ids {
			loc := fmt.Sprintf("body.addons[%d].addonVariantId", i)
			switch {
			case id == variantID:
				errs = append(errs, apperr.Field(loc, "addon.self", "a variant cannot be its own add-on"))
			case seen[id]:
				errs = append(errs, apperr.Field(loc, "addon.duplicate", "this add-on is listed twice"))
			case !exists[id]:
				errs = append(errs, apperr.Field(loc, "addon.variant_not_found", "no such variant"))
			}
			seen[id] = true
		}
		if len(errs) > 0 {
			return apperr.Validation(errs...)
		}
		if err := q.DeleteAddons(ctx, variantID); err != nil {
			return err
		}
		return q.InsertAddons(ctx, store.InsertAddonsParams{VariantID: variantID, AddonIds: ids, Required: required})
	})
	if err != nil {
		return Variant{}, err
	}
	v, err := s.q.GetVariant(ctx, store.GetVariantParams{ID: variantID, ProductID: productID})
	if err != nil {
		return Variant{}, notFound(err, "variant.not_found")
	}
	product, err := s.q.GetProduct(ctx, productID)
	if err != nil {
		return Variant{}, notFound(err, "variant.not_found")
	}
	pt, err := s.types.Get(ctx, product.ProductTypeID)
	if err != nil {
		return Variant{}, err
	}
	return s.variantDetail(ctx, actor, product, pt, v)
}

// addons returns the add-ons of the variants, by variant.
func (s *Service) addons(ctx context.Context, types *catalogTypes, variantIDs []uuid.UUID) (map[uuid.UUID][]Addon, error) {
	out := map[uuid.UUID][]Addon{}
	if len(variantIDs) == 0 {
		return out, nil
	}
	rows, err := s.q.ListAddons(ctx, variantIDs)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		pt, err := types.get(ctx, s.types, r.ProductTypeID)
		if err != nil {
			return nil, err
		}
		out[r.VariantID] = append(out[r.VariantID], Addon{
			AddonVariantID: r.AddonVariantID, ProductID: r.ProductID, ModelNumber: r.ModelNumber,
			ProductName: r.ProductName, VariantName: r.VariantName, Price: formatPrice(r.Price),
			ImageFileID: r.ImageFileID, Available: r.IsActive && r.ProductIsActive && pt.IsActive,
			Required: r.Required, SortOrder: r.SortOrder,
		})
	}
	return out, nil
}

// ---------------------------------------------------------------- helpers

// catalogTypes is a snapshot of the product types (from producttypes.Service):
// their catalog order and which are inactive, for queries and availability.
type catalogTypes struct {
	byID     map[uuid.UUID]producttypes.ProductType
	order    []uuid.UUID
	inactive []uuid.UUID
}

func (s *Service) loadTypes(ctx context.Context) (*catalogTypes, error) {
	list, err := s.types.List(ctx, true)
	if err != nil {
		return nil, err
	}
	c := &catalogTypes{byID: make(map[uuid.UUID]producttypes.ProductType, len(list)), order: make([]uuid.UUID, 0, len(list)), inactive: []uuid.UUID{}}
	for _, t := range list {
		c.byID[t.ID] = t
		c.order = append(c.order, t.ID)
		if !t.IsActive {
			c.inactive = append(c.inactive, t.ID)
		}
	}
	return c, nil
}

// get returns a type of the snapshot, or reads it if it was created after
// the snapshot was taken.
func (c *catalogTypes) get(ctx context.Context, types *producttypes.Service, id uuid.UUID) (producttypes.ProductType, error) {
	if t, ok := c.byID[id]; ok {
		return t, nil
	}
	t, err := types.Get(ctx, id)
	if err != nil {
		return t, err
	}
	c.byID[id] = t
	return t, nil
}

func typeRef(t producttypes.ProductType) ProductTypeRef {
	return ProductTypeRef{ID: t.ID, Key: t.Key, Name: t.Name, Color: t.Color, IsActive: t.IsActive}
}

func variantOut(actor auth.Actor, v store.ProductVariant, pt producttypes.ProductType, productAvailable bool, addons []Addon) Variant {
	write := actor.Can(auth.PermCatalogWrite)
	out := Variant{
		ID: v.ID, ProductID: v.ProductID, Name: v.Name, SKU: deref(v.Sku), Price: formatPrice(v.Price),
		ImageFileID: v.ImageFileID, SortOrder: v.SortOrder, IsActive: v.IsActive,
		Available: v.IsActive && productAvailable, Addons: addons,
		CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt, Can: auth.Actions{Update: write, Delete: write},
	}
	if out.Addons == nil {
		out.Addons = []Addon{}
	}
	out.Attributes, out.StaleAttributes, out.AttributeErrors = readValues(pt.Attributes, attrschema.ScopeVariant, v.Attributes)
	return out
}

// readValues splits stored values into those the schema knows (returned as
// stored) and stale ones, and reports the problems of the stored values
// against the current schema at attributes.<key>.
func readValues(schema attrschema.Schema, scope attrschema.Scope, stored attrschema.Values) (values, stale attrschema.Values, errs []apperr.FieldError) {
	_, staleValues, errs := attrschema.ValidateValues(schema, stored, "attributes",
		attrschema.Options{Scope: scope, Unknown: attrschema.UnknownKeep})
	values, stale = attrschema.Values{}, attrschema.Values(staleValues)
	for k, v := range stored {
		if _, isStale := stale[k]; !isStale {
			values[k] = v
		}
	}
	if stale == nil {
		stale = attrschema.Values{}
	}
	if errs == nil {
		errs = []apperr.FieldError{}
	}
	return values, stale, errs
}

// saveValues validates the values of a save against the current schema.
// Keys the schema does not have are kept with their stored value (untouched,
// D31) if they were stored before; new unknown keys are attribute.unknown.
func saveValues(schema attrschema.Schema, scope attrschema.Scope, in, previous attrschema.Values, location string) (attrschema.Values, []apperr.FieldError) {
	valid, stale, errs := attrschema.ValidateValues(schema, in, location,
		attrschema.Options{Scope: scope, Unknown: attrschema.UnknownKeep})
	keys := make([]string, 0, len(stale))
	for k := range stale {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if old, ok := previous[k]; ok {
			valid[k] = old
			continue
		}
		errs = append(errs, apperr.Field(location+"."+k, "attribute.unknown", "no such attribute"))
	}
	return valid, errs
}

// parsePrice checks a money string and returns it with two decimals.
func parsePrice(s string) (string, bool) {
	if !pricePattern.MatchString(s) {
		return "", false
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return "", false
	}
	return r.FloatString(2), true
}

// formatPrice renders a numeric read from the database with two decimals.
func formatPrice(s string) string {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return s
	}
	return r.FloatString(2)
}

// likePattern turns a search into an ILIKE substring pattern ("" for none),
// with the LIKE wildcards % and _ (and the escape character) matched
// literally.
func likePattern(search string) string {
	search = strings.TrimSpace(search)
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

func checkPage(limit, offset int) error {
	var errs []apperr.FieldError
	if limit < 1 || limit > MaxPageSize {
		errs = append(errs, apperr.Field("query.limit", "validation.invalid", "limit must be 1-200"))
	}
	if offset < 0 || offset > 1<<30 {
		errs = append(errs, apperr.Field("query.offset", "validation.invalid", "offset must not be negative"))
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
}

// sameSet reports whether ids holds every id of existing exactly once.
func sameSet(ids, existing []uuid.UUID) bool {
	if len(ids) != len(existing) {
		return false
	}
	want := make(map[uuid.UUID]bool, len(existing))
	for _, id := range existing {
		want[id] = true
	}
	for _, id := range ids {
		if !want[id] {
			return false
		}
		delete(want, id)
	}
	return true
}

func hasCode(err error, code string) bool {
	var e *apperr.Error
	return errors.As(err, &e) && e.Code == code
}

func notFound(err error, code string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound(code)
	}
	return err
}

// businessKey normalises a model number or SKU: Unicode NFC (so a composed
// and a decomposed "é" are the same key) and trimmed.
func businessKey(s string) string {
	return strings.TrimSpace(norm.NFC.String(s))
}

// hasControlChars reports control and format characters (Unicode Cc and
// Cf: tabs, line breaks, zero-width and bidi controls), which no business
// key may contain: they are invisible and break lookups and exports.
func hasControlChars(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool {
		return unicode.In(r, unicode.Cc, unicode.Cf)
	}) >= 0
}

func errControlChars(loc string) apperr.FieldError {
	return apperr.Field(loc, "validation.control_chars", "control characters are not allowed")
}

func tooLong(loc string, max int) apperr.FieldError {
	return apperr.Field(loc, "validation.too_long", fmt.Sprintf("longer than %d characters", max)).With("max", max)
}

func errProductStale() error {
	return apperr.Conflict("product.stale", "the product was changed by someone else")
}

func errVariantStale() error {
	return apperr.Conflict("variant.stale", "the variant was changed by someone else")
}

func errTypeNotFound() apperr.FieldError {
	return apperr.Field("body.productTypeId", "product.type_not_found", "no such product type")
}

func errFileNotFound() apperr.FieldError {
	return apperr.Field("body.imageFileId", "file.not_found", "no such file")
}

func mapProductErr(err error, modelNumber string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch {
		case pgErr.Code == "23505" && pgErr.ConstraintName == "products_model_number_key":
			return apperr.Conflict("product.model_number_taken", "model number already exists").With("modelNumber", modelNumber)
		case pgErr.Code == "23503" && pgErr.ConstraintName == "products_product_type_id_fkey":
			return apperr.Validation(errTypeNotFound())
		}
	}
	return err
}

func mapVariantErr(err error, in VariantInput, notFoundCode string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound(notFoundCode)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch {
		case pgErr.Code == "23505" && pgErr.ConstraintName == "product_variants_name_key":
			return apperr.Conflict("variant.name_taken", "the product already has a variant with this name").With("name", in.Name[i18n.DefaultLocale])
		case pgErr.Code == "23505" && pgErr.ConstraintName == "product_variants_sku_key":
			return apperr.Conflict("variant.sku_taken", "SKU already exists").With("sku", in.SKU)
		case pgErr.Code == "23503" && pgErr.ConstraintName == "product_variants_image_file_id_fkey":
			return apperr.Validation(errFileNotFound())
		case pgErr.Code == "23503" && pgErr.ConstraintName == "product_variants_product_id_fkey":
			return apperr.NotFound(notFoundCode)
		}
	}
	return err
}

func textPtr(t i18n.Text) *i18n.Text {
	if len(t) == 0 {
		return nil
	}
	return &t
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
