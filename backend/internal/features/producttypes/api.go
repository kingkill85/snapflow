package producttypes

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "product-types"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ProductTypeUpdate
}

type itemOutput struct {
	Body ProductType
}

type ProductTypeList struct {
	Items []ProductType `json:"items"`
}

type listOutput struct {
	Body ProductTypeList
}

type listInput struct {
	IncludeInactive bool `query:"includeInactive" doc:"Also list inactive product types"`
}

type ProductTypeOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"10000" doc:"Every product type id, in the new order"`
}

// Register adds the product type endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listProductTypes",
		Method:      http.MethodGet,
		Path:        "/api/product-types",
		Summary:     "List product types",
		Tags:        []string{tag},
		Description: "In catalog order (sortOrder, then key).",
	}, func(ctx context.Context, in *listInput) (*listOutput, error) {
		items, err := svc.List(ctx, in.IncludeInactive)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "reorderProductTypes",
		Method:      http.MethodPut,
		Path:        "/api/product-types/order",
		Summary:     "Set the order of product types",
		Description: "ids must list every product type (active or not) exactly once; " +
			"they get sortOrder 1..n. Returns all product types in the new order.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *struct{ Body ProductTypeOrder }) (*listOutput, error) {
		items, err := svc.Reorder(ctx, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getProductType",
		Method:      http.MethodGet,
		Path:        "/api/product-types/{id}",
		Summary:     "Get a product type",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		item, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createProductType",
		Method:        http.MethodPost,
		Path:          "/api/product-types",
		Summary:       "Create a product type",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body ProductTypeInput }) (*itemOutput, error) {
		item, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateProductType",
		Method:      http.MethodPut,
		Path:        "/api/product-types/{id}",
		Summary:     "Update a product type",
		Description: "Fails with 409 product_type.stale if the type changed since expectedUpdatedAt.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*itemOutput, error) {
		item, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteProductType",
		Method:        http.MethodDelete,
		Path:          "/api/product-types/{id}",
		Summary:       "Delete a product type",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})
}
