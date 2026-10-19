package products

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "products"

type productIDParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type variantIDParams struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	VariantID uuid.UUID `path:"variantId" format:"uuid"`
}

type listInput struct {
	ProductTypeID   uuid.UUID `query:"productTypeId" format:"uuid" doc:"Only products of this type"`
	CategoryID      uuid.UUID `query:"categoryId" format:"uuid" doc:"Only products of this category"`
	Search          string    `query:"search" maxLength:"200" doc:"Case-insensitive substring of model number, English or German name or description, or a variant's SKU"`
	IncludeInactive bool      `query:"includeInactive" doc:"Also list inactive products and products of inactive types or categories"`
	Limit           int       `query:"limit" default:"50" minimum:"1" maximum:"200" doc:"Page size, 1-200"`
	Offset          int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type listOutput struct {
	Body ProductPage
}

type productOutput struct {
	Body Product
}

type variantOutput struct {
	Body Variant
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ProductUpdate
}

type createVariantInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body VariantInput
}

type updateVariantInput struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	VariantID uuid.UUID `path:"variantId" format:"uuid"`
	Body      VariantUpdate
}

type VariantOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"10000" doc:"Every variant id of the product, in the new order"`
}

type reorderInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body VariantOrder
}

type AddonList struct {
	Addons []AddonInput `json:"addons" maxItems:"1000" doc:"The complete add-on list in order (at most 100)"`
}

type addonsInput struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	VariantID uuid.UUID `path:"variantId" format:"uuid"`
	Body      AddonList
}

type variantSearchInput struct {
	ProductTypeID uuid.UUID `query:"productTypeId" format:"uuid" doc:"Only variants of products of this type"`
	CategoryID    uuid.UUID `query:"categoryId" format:"uuid" doc:"Only variants of products of this category"`
	Search        string    `query:"search" maxLength:"200" doc:"Case-insensitive substring of model number, product name or description, variant name (en/de) or SKU; empty lists every variant"`
	Limit         int       `query:"limit" default:"50" minimum:"1" maximum:"200" doc:"Page size, 1-200"`
	Offset        int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
	// The palettes need the capabilities; other pickers skip computing them.
	WithCapabilities bool `query:"withCapabilities" doc:"Include each variant's capability summary (board and floorplan palettes)"`
}

type variantSearchOutput struct {
	Body VariantPage
}

// Register adds the product, variant and add-on endpoints. Handlers only
// translate HTTP to service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listProducts",
		Method:      http.MethodGet,
		Path:        "/api/products",
		Summary:     "List products",
		Description: "One page in catalog order: product type order, category order, then model number.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *listInput) (*listOutput, error) {
		p := ListParams{Search: in.Search, IncludeInactive: in.IncludeInactive, Limit: in.Limit, Offset: in.Offset}
		if in.ProductTypeID != uuid.Nil {
			p.ProductTypeID = &in.ProductTypeID
		}
		if in.CategoryID != uuid.Nil {
			p.CategoryID = &in.CategoryID
		}
		page, err := svc.List(ctx, p)
		if err != nil {
			return nil, err
		}
		return &listOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getProduct",
		Method:      http.MethodGet,
		Path:        "/api/products/{id}",
		Summary:     "Get a product with its variants and add-ons",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *productIDParam) (*productOutput, error) {
		p, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &productOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createProduct",
		Method:        http.MethodPost,
		Path:          "/api/products",
		Summary:       "Create a product",
		Description:   "Without variants; add them with createVariant.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body ProductInput }) (*productOutput, error) {
		p, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &productOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateProduct",
		Method:      http.MethodPut,
		Path:        "/api/products/{id}",
		Summary:     "Update a product",
		Description: "The product's own fields; variants are unchanged. Fails with 409 product.stale if the product changed since expectedUpdatedAt. " +
			"Changing the category never refuses because of the variants' values: they are flagged (variantsWithProblems, attributeErrors, staleAttributes).",
		Tags: []string{tag},
	}, func(ctx context.Context, in *updateInput) (*productOutput, error) {
		p, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &productOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteProduct",
		Method:        http.MethodDelete,
		Path:          "/api/products/{id}",
		Summary:       "Delete a product with its variants and add-on links",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *productIDParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createVariant",
		Method:        http.MethodPost,
		Path:          "/api/products/{id}/variants",
		Summary:       "Add a variant",
		Description:   "Appended after the product's other variants.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createVariantInput) (*variantOutput, error) {
		v, err := svc.CreateVariant(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &variantOutput{Body: v}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "reorderVariants",
		Method:      http.MethodPut,
		Path:        "/api/products/{id}/variants/order",
		Summary:     "Set the order of a product's variants",
		Description: "ids must list every variant of the product exactly once (422 variant.order_mismatch). Returns the product.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *reorderInput) (*productOutput, error) {
		p, err := svc.ReorderVariants(ctx, in.ID, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &productOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateVariant",
		Method:      http.MethodPut,
		Path:        "/api/products/{id}/variants/{variantId}",
		Summary:     "Update a variant",
		Description: "Add-ons are unchanged. Fails with 409 variant.stale if the variant changed since expectedUpdatedAt.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateVariantInput) (*variantOutput, error) {
		v, err := svc.UpdateVariant(ctx, in.ID, in.VariantID, in.Body)
		if err != nil {
			return nil, err
		}
		return &variantOutput{Body: v}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteVariant",
		Method:        http.MethodDelete,
		Path:          "/api/products/{id}/variants/{variantId}",
		Summary:       "Delete a variant and its add-on links (both directions)",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *variantIDParams) (*struct{}, error) {
		return nil, svc.DeleteVariant(ctx, in.ID, in.VariantID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "replaceVariantAddons",
		Method:      http.MethodPut,
		Path:        "/api/products/{id}/variants/{variantId}/addons",
		Summary:     "Replace a variant's add-ons",
		Description: "The complete list in order, in one transaction. Every add-on variant must exist " +
			"(addon.variant_not_found), differ from the variant (addon.self) and appear once (addon.duplicate). " +
			"Returns the variant.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *addonsInput) (*variantOutput, error) {
		v, err := svc.ReplaceAddons(ctx, in.ID, in.VariantID, in.Body.Addons)
		if err != nil {
			return nil, err
		}
		return &variantOutput{Body: v}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "searchVariants",
		Method:      http.MethodGet,
		Path:        "/api/variants",
		Summary:     "List or search variants across the catalog",
		Description: "For the add-on picker; in catalog order (product type, category, model number, variant order). " +
			"Without search it lists every variant (browsing, paged with offset). " +
			"Lists inactive variants too, flagged by available.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *variantSearchInput) (*variantSearchOutput, error) {
		p := VariantSearchParams{Search: in.Search, Limit: in.Limit, Offset: in.Offset, WithCapabilities: in.WithCapabilities}
		if in.ProductTypeID != uuid.Nil {
			p.ProductTypeID = &in.ProductTypeID
		}
		if in.CategoryID != uuid.Nil {
			p.CategoryID = &in.CategoryID
		}
		page, err := svc.SearchVariants(ctx, p)
		if err != nil {
			return nil, err
		}
		return &variantSearchOutput{Body: page}, nil
	})
}
