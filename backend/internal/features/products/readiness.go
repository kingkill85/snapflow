package products

import (
	"context"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products/store"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// ReadinessProduct is an available product with what SnapFlow knows about
// it, for the catalog readiness check (D446).
type ReadinessProduct struct {
	ID            uuid.UUID
	ModelNumber   string
	Name          i18n.Text
	ProductTypeID uuid.UUID
	CategoryID    uuid.UUID
	// Capabilities are the product's own (Missing merged with its active
	// variants', as on the product page); Variants those of its active
	// variants.
	Capabilities capabilities.Capabilities
	Variants     []capabilities.Capabilities
}

// ReadinessProducts computes the capabilities of every available product
// (product, category and product type active) and its active variants in
// one pass over the catalog, in model number order. Needs catalog.read.
func (s *Service) ReadinessProducts(ctx context.Context) ([]ReadinessProduct, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	var (
		rows     []store.Product
		variants []store.ProductVariant
	)
	err := s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		if rows, err = q.CatalogProducts(ctx); err != nil {
			return err
		}
		variants, err = q.CatalogVariants(ctx)
		return err
	})
	if err != nil {
		return nil, err
	}
	cats, err := s.cats.List(ctx, false)
	if err != nil {
		return nil, err
	}
	catByID := make(map[uuid.UUID]categories.Category, len(cats))
	for _, c := range cats {
		catByID[c.ID] = c
	}
	types, err := s.types.List(ctx, false)
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
	byProduct := map[uuid.UUID][]store.ProductVariant{}
	for _, v := range variants {
		if v.IsActive {
			byProduct[v.ProductID] = append(byProduct[v.ProductID], v)
		}
	}
	out := []ReadinessProduct{}
	for _, r := range rows {
		c, okC := catByID[r.CategoryID]
		pt, okT := typeByID[r.ProductTypeID]
		if !r.IsActive || !okC || !okT {
			continue
		}
		p := ReadinessProduct{ID: r.ID, ModelNumber: r.ModelNumber, Name: r.Name, ProductTypeID: r.ProductTypeID, CategoryID: r.CategoryID,
			Capabilities: capabilities.Compute(reg, capabilityInput(pt, r.Mounting, c, r.Attributes, nil))}
		for _, v := range byProduct[r.ID] {
			p.Variants = append(p.Variants, capabilities.Compute(reg, capabilityInput(pt, r.Mounting, c, r.Attributes, v.Attributes)))
		}
		p.Capabilities.Missing = capabilities.MergeMissing(p.Capabilities, p.Variants)
		out = append(out, p)
	}
	return out, nil
}
