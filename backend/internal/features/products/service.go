// Package products manages the products of the global catalog with their
// variants and add-ons (one aggregate). A product belongs to a product type
// (its system or product line) and a category (its kind of device) whose
// attribute schema its values follow; variants carry the price and image;
// add-ons link a variant to variants that go with it. Reads need
// catalog.read, writes catalog.write.
//
// Product types and categories are read through producttypes.Service and
// categories.Service, and files are checked through files.Service; this
// feature never reads their tables.
package products

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
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
	cats  *categories.Service
	files *files.Service
	caps  *capabilities.Service
}

func NewService(db DB, types *producttypes.Service, cats *categories.Service, files *files.Service, caps *capabilities.Service) *Service {
	return &Service{db: db, q: store.New(db), types: types, cats: cats, files: files, caps: caps}
}

// WithTx returns the service working inside tx (see database.Nested), with
// product types, categories and files read and written in tx too. Its transactions
// become savepoints, so a refused write (a taken SKU, say) leaves tx usable.
func (s *Service) WithTx(tx pgx.Tx) *Service {
	return NewService(database.NewNested(tx), s.types.WithTx(tx), s.cats.WithTx(tx), s.files.WithTx(tx), s.caps.WithTx(tx))
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
// category order, then model number). Without IncludeInactive only active
// products of active types and active categories are listed.
func (s *Service) List(ctx context.Context, p ListParams) (ProductPage, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return ProductPage{}, err
	}
	if err := checkPage(p.Limit, p.Offset); err != nil {
		return ProductPage{}, err
	}
	cat, err := s.loadCatalog(ctx)
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
			TypeIds: cat.typeOrder, CategoryIds: cat.categoryOrder,
			ProductTypeID: p.ProductTypeID, CategoryID: p.CategoryID, IncludeInactive: p.IncludeInactive,
			InactiveTypeIds: cat.inactiveTypes, InactiveCategoryIds: cat.inactiveCategories, Search: pattern,
			RowLimit: int32(p.Limit), RowOffset: int32(p.Offset), //nolint:gosec // checked by checkPage
		})
		if err != nil {
			return err
		}
		total, err = q.CountProducts(ctx, store.CountProductsParams{
			ProductTypeID: p.ProductTypeID, CategoryID: p.CategoryID, IncludeInactive: p.IncludeInactive,
			InactiveTypeIds: cat.inactiveTypes, InactiveCategoryIds: cat.inactiveCategories, Search: pattern,
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
		pt, err := cat.typeOf(ctx, s, r.ProductTypeID)
		if err != nil {
			return ProductPage{}, err
		}
		c, err := cat.categoryOf(ctx, s, r.CategoryID)
		if err != nil {
			return ProductPage{}, err
		}
		item := ProductListItem{
			ID: r.ID, ProductTypeID: r.ProductTypeID, ProductType: typeRef(pt),
			CategoryID: r.CategoryID, Category: categoryRef(c), ModelNumber: r.ModelNumber,
			Name: r.Name, IsActive: r.IsActive, Available: r.IsActive && pt.IsActive && c.IsActive,
			Can: auth.Actions{Update: write, Delete: write},
		}
		_, stale, errs := readValues(c.Attributes, attrschema.ScopeProduct, r.Attributes)
		item.AttributeErrors, item.StaleAttributes = len(errs), len(stale)
		var lo, hi *big.Rat
		for _, v := range byProduct[r.ID] {
			item.VariantCount++
			_, stale, errs := readValues(c.Attributes, attrschema.ScopeVariant, v.Attributes)
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
	row, err := s.createProduct(ctx, in, Known{})
	if err != nil {
		return Product{}, err
	}
	return s.detail(ctx, actor, row)
}

func (s *Service) createProduct(ctx context.Context, in ProductInput, known Known) (store.Product, error) {
	in, err := s.validateProduct(ctx, in, nil, known)
	if err != nil {
		return store.Product{}, err
	}
	var row store.Product
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.CreateProduct(ctx, store.CreateProductParams{
			ProductTypeID: in.ProductTypeID, CategoryID: in.CategoryID, ModelNumber: in.ModelNumber, Name: in.Name,
			Description: textPtr(in.Description), Attributes: in.Attributes, IsActive: in.IsActive, Mounting: mountingPtr(in.Mounting),
		})
		return err
	})
	if err != nil {
		return store.Product{}, mapProductErr(err, in.ModelNumber)
	}
	return row, nil
}

// Update replaces a product's own fields (not its variants). It fails with
// product.stale if the product changed since in.ExpectedUpdatedAt. Values
// whose key the (new) category's schema does not have are kept only if they
// were stored before and are sent back. The category may change, also to one
// whose schema the variants' values do not match: those are only flagged on
// read (Product.VariantsWithProblems), never re-validated or refused.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in ProductUpdate) (Product, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Product{}, err
	}
	row, err := s.updateProduct(ctx, id, in, false, Known{})
	if err != nil {
		return Product{}, err
	}
	return s.detail(ctx, actor, row)
}

// updateProduct validates and writes an update; raw writes in as it is
// (undoing an import restores a state that existed).
func (s *Service) updateProduct(ctx context.Context, id uuid.UUID, in ProductUpdate, raw bool, known Known) (store.Product, error) {
	current, err := s.q.GetProduct(ctx, id)
	if err != nil {
		return store.Product{}, notFound(err, "product.not_found")
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return store.Product{}, errProductStale()
	}
	if in.Mounting == nil {
		// Left out keeps the stored override (D294).
		in.Mounting = current.Mounting
	}
	if !raw {
		in.ProductInput, err = s.validateProduct(ctx, in.ProductInput, &current, known)
		if err != nil {
			return store.Product{}, err
		}
	}
	var row store.Product
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateProduct(ctx, store.UpdateProductParams{
			ID: id, ProductTypeID: in.ProductTypeID, CategoryID: in.CategoryID, ModelNumber: in.ModelNumber, Name: in.Name,
			Description: textPtr(in.Description), Attributes: in.Attributes, IsActive: in.IsActive, Mounting: mountingPtr(in.Mounting),
			ExpectedUpdatedAt: in.ExpectedUpdatedAt,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Product{}, s.productGoneOrStale(ctx, id)
	}
	if err != nil {
		return store.Product{}, mapProductErr(err, in.ModelNumber)
	}
	return row, nil
}

// productGoneOrStale explains an update that matched no row.
func (s *Service) productGoneOrStale(ctx context.Context, id uuid.UUID) error {
	exists, err := s.q.ProductExists(ctx, id)
	if err != nil {
		return err
	}
	if exists {
		return errProductStale()
	}
	return apperr.NotFound("product.not_found")
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
// The product type and category are read unless known has them.
func (s *Service) validateProduct(ctx context.Context, in ProductInput, current *store.Product, known Known) (ProductInput, error) {
	var existing *Existing
	if current != nil {
		existing = &Existing{ProductTypeID: current.ProductTypeID, CategoryID: current.CategoryID, Attributes: current.Attributes}
	}
	ptp := known.Type
	if ptp == nil || ptp.ID != in.ProductTypeID {
		ptp = nil
		pt, err := s.types.Get(ctx, in.ProductTypeID)
		switch {
		case hasCode(err, "product_type.not_found"):
		case err != nil:
			return in, err
		default:
			ptp = &pt
		}
	}
	cp := known.Category
	if cp == nil || cp.ID != in.CategoryID {
		cp = nil
		c, err := s.cats.Get(ctx, in.CategoryID)
		switch {
		case hasCode(err, "category.not_found"):
		case err != nil:
			return in, err
		default:
			cp = &c
		}
	}
	// nil reports the type or category as not found (and skips the
	// attribute checks without a category).
	in, errs := normalizeProduct(ptp, cp, in, existing, "body")
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// detail reads a product's variants and add-ons and builds the response.
func (s *Service) detail(ctx context.Context, actor auth.Actor, row store.Product) (Product, error) {
	cat, err := s.loadCatalog(ctx)
	if err != nil {
		return Product{}, err
	}
	pt, err := cat.typeOf(ctx, s, row.ProductTypeID)
	if err != nil {
		return Product{}, err
	}
	c, err := cat.categoryOf(ctx, s, row.CategoryID)
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
	addons, err := s.addons(ctx, cat, ids)
	if err != nil {
		return Product{}, err
	}
	reg, err := s.caps.Registry(ctx)
	if err != nil {
		return Product{}, err
	}
	write := actor.Can(auth.PermCatalogWrite)
	p := Product{
		ID: row.ID, ProductTypeID: row.ProductTypeID, ProductType: typeRef(pt),
		CategoryID: row.CategoryID, Category: categoryRef(c), ModelNumber: row.ModelNumber,
		Name: row.Name, IsActive: row.IsActive, Available: row.IsActive && pt.IsActive && c.IsActive,
		Mounting:  deref(row.Mounting),
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Can: auth.Actions{Update: write, Delete: write},
	}
	if row.Description != nil {
		p.Description = *row.Description
	}
	p.Attributes, p.StaleAttributes, p.AttributeErrors = readValues(c.Attributes, attrschema.ScopeProduct, row.Attributes)
	p.Capabilities = capabilities.Compute(reg, capabilityInput(pt, row.Mounting, c, row.Attributes, nil))
	p.Variants = make([]Variant, len(variants))
	for i, v := range variants {
		p.Variants[i] = variantOut(actor, v, c.Attributes, p.Available, addons[v.ID])
		p.Variants[i].Capabilities = capabilities.Compute(reg, capabilityInput(pt, row.Mounting, c, row.Attributes, v.Attributes))
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
	product, row, err := s.createVariant(ctx, productID, in, Known{})
	if err != nil {
		return Variant{}, err
	}
	return s.variantDetail(ctx, actor, product, row)
}

// createVariant validates and writes a new variant. With a known category
// (the product's, read by the caller in the same transaction) the product is
// not read first and the returned product is empty; LockProduct still finds
// a missing product.
func (s *Service) createVariant(ctx context.Context, productID uuid.UUID, in VariantInput, known Known) (store.Product, store.ProductVariant, error) {
	var (
		row     store.ProductVariant
		product store.Product
		err     error
	)
	c := known.Category
	if c == nil {
		product, err = s.q.GetProduct(ctx, productID)
		if err != nil {
			return product, row, notFound(err, "product.not_found")
		}
		cat, err := s.cats.Get(ctx, product.CategoryID)
		if err != nil {
			return product, row, err
		}
		c = &cat
	}
	in, err = s.validateVariant(ctx, *c, in, nil)
	if err != nil {
		return product, row, err
	}
	err = s.inTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockProduct(ctx, productID); err != nil {
			return err
		}
		var err error
		row, err = q.CreateVariant(ctx, store.CreateVariantParams{
			ProductID: productID, Name: in.Name, Sku: strPtr(in.SKU), Price: in.Price,
			ImageFileID: in.ImageFileID, Attributes: in.Attributes, IsActive: in.IsActive,
		})
		return err
	})
	if err != nil {
		return product, row, mapVariantErr(err, in, "product.not_found")
	}
	return product, row, nil
}

// UpdateVariant replaces a variant (not its add-ons). It fails with
// variant.stale if the variant changed since in.ExpectedUpdatedAt.
func (s *Service) UpdateVariant(ctx context.Context, productID, id uuid.UUID, in VariantUpdate) (Variant, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Variant{}, err
	}
	product, row, err := s.updateVariant(ctx, productID, id, in, false, Known{})
	if err != nil {
		return Variant{}, err
	}
	return s.variantDetail(ctx, actor, product, row)
}

// updateVariant validates and writes an update; raw writes in as it is
// (undoing an import restores a state that existed). With a known category
// (the product's) the product is not read and the returned product is
// empty.
func (s *Service) updateVariant(ctx context.Context, productID, id uuid.UUID, in VariantUpdate, raw bool, known Known) (store.Product, store.ProductVariant, error) {
	var (
		product store.Product
		row     store.ProductVariant
	)
	current, err := s.q.GetVariant(ctx, store.GetVariantParams{ID: id, ProductID: productID})
	if err != nil {
		return product, row, notFound(err, "variant.not_found")
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return product, row, errVariantStale()
	}
	if raw || known.Category == nil {
		product, err = s.q.GetProduct(ctx, productID)
		if err != nil {
			return product, row, notFound(err, "variant.not_found")
		}
	}
	if !raw {
		c := known.Category
		if c == nil {
			cat, err := s.cats.Get(ctx, product.CategoryID)
			if err != nil {
				return product, row, err
			}
			c = &cat
		}
		in.VariantInput, err = s.validateVariant(ctx, *c, in.VariantInput, current.Attributes)
		if err != nil {
			return product, row, err
		}
	}
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
		return product, row, s.variantGoneOrStale(ctx, productID, id)
	}
	if err != nil {
		return product, row, mapVariantErr(err, in.VariantInput, "variant.not_found")
	}
	return product, row, nil
}

// variantGoneOrStale explains an update that matched no row.
func (s *Service) variantGoneOrStale(ctx context.Context, productID, id uuid.UUID) error {
	exists, err := s.q.VariantExists(ctx, store.VariantExistsParams{ID: id, ProductID: productID})
	if err != nil {
		return err
	}
	if exists {
		return errVariantStale()
	}
	return apperr.NotFound("variant.not_found")
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

func (s *Service) validateVariant(ctx context.Context, c categories.Category, in VariantInput, previous attrschema.Values) (VariantInput, error) {
	in, errs := NormalizeVariant(c, in, previous, "body")
	if in.ImageFileID != nil {
		exists, err := s.files.Exists(ctx, files.Catalog, *in.ImageFileID)
		if err != nil {
			return in, err
		}
		if !exists {
			// Before the attribute errors, in the order of the form.
			i := slices.IndexFunc(errs, func(e apperr.FieldError) bool { return strings.HasPrefix(e.Location, "body.attributes") })
			if i < 0 {
				i = len(errs)
			}
			errs = slices.Insert(errs, i, errFileNotFound())
		}
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// variantDetail builds the response of a single variant.
func (s *Service) variantDetail(ctx context.Context, actor auth.Actor, product store.Product, v store.ProductVariant) (Variant, error) {
	cat, err := s.loadCatalog(ctx)
	if err != nil {
		return Variant{}, err
	}
	pt, err := cat.typeOf(ctx, s, product.ProductTypeID)
	if err != nil {
		return Variant{}, err
	}
	c, err := cat.categoryOf(ctx, s, product.CategoryID)
	if err != nil {
		return Variant{}, err
	}
	addons, err := s.addons(ctx, cat, []uuid.UUID{v.ID})
	if err != nil {
		return Variant{}, err
	}
	reg, err := s.caps.Registry(ctx)
	if err != nil {
		return Variant{}, err
	}
	out := variantOut(actor, v, c.Attributes, product.IsActive && pt.IsActive && c.IsActive, addons[v.ID])
	out.Capabilities = capabilities.Compute(reg, capabilityInput(pt, product.Mounting, c, product.Attributes, v.Attributes))
	return out, nil
}

// SearchVariants lists variants across the catalog (add-on picker) in
// catalog order: product type, category, model number, variant order.
// Without a search it lists every variant (browsing); ProductTypeID and
// CategoryID narrow it to one type or category.
func (s *Service) SearchVariants(ctx context.Context, p VariantSearchParams) (VariantPage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return VariantPage{}, err
	}
	if err := checkPage(p.Limit, p.Offset); err != nil {
		return VariantPage{}, err
	}
	cat, err := s.loadCatalog(ctx)
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
			TypeIds: cat.typeOrder, CategoryIds: cat.categoryOrder,
			ProductTypeID: p.ProductTypeID, CategoryID: p.CategoryID, Search: pattern,
			RowLimit: int32(p.Limit), RowOffset: int32(p.Offset), //nolint:gosec // checked by checkPage
		})
		if err != nil {
			return err
		}
		total, err = q.CountVariants(ctx, store.CountVariantsParams{
			ProductTypeID: p.ProductTypeID, CategoryID: p.CategoryID, Search: pattern,
		})
		return err
	})
	if err != nil {
		return VariantPage{}, err
	}
	items := make([]VariantSearchItem, len(rows))
	for i, r := range rows {
		pt, err := cat.typeOf(ctx, s, r.ProductTypeID)
		if err != nil {
			return VariantPage{}, err
		}
		c, err := cat.categoryOf(ctx, s, r.CategoryID)
		if err != nil {
			return VariantPage{}, err
		}
		items[i] = VariantSearchItem{
			ID: r.ID, ProductID: r.ProductID, ProductTypeID: r.ProductTypeID, ProductType: typeRef(pt),
			CategoryID: r.CategoryID, Category: categoryRef(c),
			ModelNumber: r.ModelNumber, ProductName: r.ProductName, Name: r.Name, SKU: deref(r.Sku),
			Price: formatPrice(r.Price), ImageFileID: r.ImageFileID,
			Available: r.IsActive && r.ProductIsActive && pt.IsActive && c.IsActive,
		}
	}
	ids := make([]uuid.UUID, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	caps, err := s.Capabilities(ctx, ids)
	if err != nil {
		return VariantPage{}, err
	}
	for i := range items {
		items[i].Capabilities = caps[items[i].ID]
	}
	return VariantPage{Items: items, Total: total}, nil
}

// ---------------------------------------------------------------- add-ons

// ReplaceAddons replaces a variant's add-ons with list (in list order) in
// one transaction. Every add-on must exist, differ from the variant and
// appear once; all problems are reported together. Cycles are allowed.
//
// The list's version (CatalogVariant.AddonsUpdatedAt) moves on; the
// variant's updatedAt does not (D56).
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
	if err := s.replaceAddons(ctx, productID, variantID, list); err != nil {
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
	return s.variantDetail(ctx, actor, product, v)
}

func (s *Service) replaceAddons(ctx context.Context, productID, variantID uuid.UUID, list []AddonInput) error {
	if len(list) > MaxAddons {
		return apperr.Validation(apperr.Field("body.addons", "validation.too_many",
			fmt.Sprintf("at most %d add-ons", MaxAddons)).With("max", MaxAddons))
	}
	return s.inTx(ctx, func(q *store.Queries) error {
		if _, err := q.ShareProduct(ctx, productID); err != nil {
			return notFound(err, "variant.not_found")
		}
		if _, err := q.TouchVariantAddons(ctx, store.TouchVariantAddonsParams{ID: variantID, ProductID: productID}); err != nil {
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
}

// addons returns the add-ons of the variants, by variant.
func (s *Service) addons(ctx context.Context, cat *catalog, variantIDs []uuid.UUID) (map[uuid.UUID][]Addon, error) {
	out := map[uuid.UUID][]Addon{}
	if len(variantIDs) == 0 {
		return out, nil
	}
	rows, err := s.q.ListAddons(ctx, variantIDs)
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
		out[r.VariantID] = append(out[r.VariantID], Addon{
			AddonVariantID: r.AddonVariantID, ProductID: r.ProductID, ModelNumber: r.ModelNumber,
			ProductName: r.ProductName, VariantName: r.VariantName, Price: formatPrice(r.Price),
			ImageFileID: r.ImageFileID, Available: r.IsActive && r.ProductIsActive && pt.IsActive && c.IsActive,
			Required: r.Required, SortOrder: r.SortOrder,
		})
	}
	return out, nil
}

// ---------------------------------------------------------------- helpers

// catalog is a snapshot of the product types and categories (from
// producttypes.Service and categories.Service): their catalog order and which
// are inactive, for queries and availability, and the categories' schemas.
type catalog struct {
	types              map[uuid.UUID]producttypes.ProductType
	categories         map[uuid.UUID]categories.Category
	typeOrder          []uuid.UUID
	categoryOrder      []uuid.UUID
	inactiveTypes      []uuid.UUID
	inactiveCategories []uuid.UUID
}

func (s *Service) loadCatalog(ctx context.Context) (*catalog, error) {
	types, err := s.types.List(ctx, true)
	if err != nil {
		return nil, err
	}
	cats, err := s.cats.List(ctx, true)
	if err != nil {
		return nil, err
	}
	c := &catalog{
		types: make(map[uuid.UUID]producttypes.ProductType, len(types)), categories: make(map[uuid.UUID]categories.Category, len(cats)),
		typeOrder: make([]uuid.UUID, 0, len(types)), categoryOrder: make([]uuid.UUID, 0, len(cats)),
		inactiveTypes: []uuid.UUID{}, inactiveCategories: []uuid.UUID{},
	}
	for _, t := range types {
		c.types[t.ID] = t
		c.typeOrder = append(c.typeOrder, t.ID)
		if !t.IsActive {
			c.inactiveTypes = append(c.inactiveTypes, t.ID)
		}
	}
	for _, k := range cats {
		c.categories[k.ID] = k
		c.categoryOrder = append(c.categoryOrder, k.ID)
		if !k.IsActive {
			c.inactiveCategories = append(c.inactiveCategories, k.ID)
		}
	}
	return c, nil
}

// typeOf returns a type of the snapshot, or reads it if it was created after
// the snapshot was taken.
func (c *catalog) typeOf(ctx context.Context, s *Service, id uuid.UUID) (producttypes.ProductType, error) {
	if t, ok := c.types[id]; ok {
		return t, nil
	}
	t, err := s.types.Get(ctx, id)
	if err != nil {
		return t, err
	}
	c.types[id] = t
	return t, nil
}

// categoryOf returns a category of the snapshot, or reads it if it was
// created after the snapshot was taken.
func (c *catalog) categoryOf(ctx context.Context, s *Service, id uuid.UUID) (categories.Category, error) {
	if k, ok := c.categories[id]; ok {
		return k, nil
	}
	k, err := s.cats.Get(ctx, id)
	if err != nil {
		return k, err
	}
	c.categories[id] = k
	return k, nil
}

// capabilityInput is what capabilities.Compute needs of a product (variant
// values nil) or a variant: the effective mounting and the values of both.
func capabilityInput(pt producttypes.ProductType, mounting *string, c categories.Category, product, variant attrschema.Values) capabilities.Input {
	values := attrschema.Values{}
	for k, v := range product {
		values[k] = v
	}
	for k, v := range variant {
		values[k] = v
	}
	return capabilities.Input{ProductTypeID: pt.ID, Mounting: EffectiveMounting(mounting, c), Schema: c.Attributes, Values: values,
		ProductType: capabilities.ProductTypeDefaults{Topology: capabilities.Topology(pt.Topology),
			DefaultBusCurrentMa: pt.DefaultBusCurrentMa, DefaultWirelessPlacesUsed: pt.DefaultWirelessPlacesUsed}}
}

// EffectiveMounting is the product's mounting override, else its
// category's (D189).
func EffectiveMounting(override *string, c categories.Category) string {
	if override != nil && *override != "" {
		return *override
	}
	if c.Mounting == "" {
		return string(capabilities.MountingFloorplan)
	}
	return c.Mounting
}

// Capabilities computes the capabilities of variants (with their product's
// values), by id; unknown ids are left out. Later steps (boards, checks)
// call it. Needs catalog.read.
func (s *Service) Capabilities(ctx context.Context, variantIDs []uuid.UUID) (map[uuid.UUID]capabilities.Capabilities, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	rows, err := s.q.CapabilityVariants(ctx, variantIDs)
	if err != nil {
		return nil, err
	}
	cats, err := s.cats.List(ctx, true)
	if err != nil {
		return nil, err
	}
	byID := make(map[uuid.UUID]categories.Category, len(cats))
	for _, c := range cats {
		byID[c.ID] = c
	}
	types, err := s.types.List(ctx, true)
	if err != nil {
		return nil, err
	}
	typeByID := make(map[uuid.UUID]producttypes.ProductType, len(types))
	for _, t := range types {
		typeByID[t.ID] = t
	}
	reg, err := s.caps.Registry(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]capabilities.Capabilities, len(rows))
	for _, r := range rows {
		out[r.ID] = capabilities.Compute(reg, capabilityInput(typeByID[r.ProductTypeID], r.Mounting, byID[r.CategoryID], r.ProductAttributes, r.Attributes))
	}
	return out, nil
}

func typeRef(t producttypes.ProductType) ProductTypeRef {
	return ProductTypeRef{ID: t.ID, Key: t.Key, Name: t.Name, Abbreviation: t.Abbreviation, Color: t.Color, IsActive: t.IsActive}
}

func categoryRef(c categories.Category) CategoryRef {
	return CategoryRef{ID: c.ID, Key: c.Key, Name: c.Name, IsActive: c.IsActive}
}

func variantOut(actor auth.Actor, v store.ProductVariant, schema attrschema.Schema, productAvailable bool, addons []Addon) Variant {
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
	out.Attributes, out.StaleAttributes, out.AttributeErrors = readValues(schema, attrschema.ScopeVariant, v.Attributes)
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

func errCategoryNotFound() apperr.FieldError {
	return apperr.Field("body.categoryId", "product.category_not_found", "no such category")
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
		case pgErr.Code == "23503" && pgErr.ConstraintName == "products_category_id_fkey":
			return apperr.Validation(errCategoryNotFound())
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

// mountingPtr is the stored form of a mounting override: nil for none.
func mountingPtr(s *string) *string {
	if s == nil {
		return nil
	}
	return strPtr(*s)
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
