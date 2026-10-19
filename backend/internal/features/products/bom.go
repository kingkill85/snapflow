package products

import (
	"context"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products/store"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// BOMVariant is what a BOM price snapshot (step 2c) keeps of a catalog
// variant, with its live availability.
type BOMVariant struct {
	ID          uuid.UUID
	ProductID   uuid.UUID
	ProductName i18n.Text
	VariantName i18n.Text
	ModelNumber string
	SKU         *string
	// Price is the list price in USD, a decimal string.
	Price       string
	ImageFileID *uuid.UUID
	ProductType producttypes.ProductType
	Category    categories.Category
	// RequiredAddonIDs are the variant's required add-ons that are
	// available (D54: the BOM adds only available required add-ons), in
	// add-on order.
	RequiredAddonIDs []uuid.UUID
	// Available: variant, product, product type and category active (D54).
	Available bool
}

// BOMVariants returns the variants of ids that exist, by id (deleted ones
// are left out). Needs catalog.read.
func (s *Service) BOMVariants(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]BOMVariant, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	out := map[uuid.UUID]BOMVariant{}
	if len(ids) == 0 {
		return out, nil
	}
	cat, err := s.loadCatalog(ctx)
	if err != nil {
		return nil, err
	}
	var (
		rows   []store.BOMVariantsRow
		addons []store.ListAddonsRow
	)
	err = s.inSnapshot(ctx, func(q *store.Queries) error {
		var err error
		if rows, err = q.BOMVariants(ctx, ids); err != nil {
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
		out[r.ID] = BOMVariant{
			ID: r.ID, ProductID: r.ProductID, ProductName: r.ProductName, VariantName: r.Name, ModelNumber: r.ModelNumber,
			SKU: r.Sku, Price: r.Price, ImageFileID: r.ImageFileID, ProductType: pt, Category: c,
			RequiredAddonIDs: []uuid.UUID{},
			Available:        r.IsActive && r.ProductIsActive && pt.IsActive && c.IsActive,
		}
	}
	for _, a := range addons {
		v, ok := out[a.VariantID]
		if !ok || !a.Required {
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
		if a.IsActive && a.ProductIsActive && pt.IsActive && c.IsActive {
			v.RequiredAddonIDs = append(v.RequiredAddonIDs, a.AddonVariantID)
			out[a.VariantID] = v
		}
	}
	return out, nil
}
