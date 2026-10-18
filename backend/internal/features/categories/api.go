package categories

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "categories"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body CategoryUpdate
}

type itemOutput struct {
	Body Category
}

type CategoryList struct {
	Items []Category `json:"items"`
}

type listOutput struct {
	Body CategoryList
}

type listInput struct {
	IncludeInactive bool `query:"includeInactive" doc:"Also list inactive categories"`
}

type CategoryOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"10000" doc:"Every category id, in the new order"`
}

// Register adds the category endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listCategories",
		Method:      http.MethodGet,
		Path:        "/api/categories",
		Summary:     "List categories",
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
		OperationID: "reorderCategories",
		Method:      http.MethodPut,
		Path:        "/api/categories/order",
		Summary:     "Set the order of categories",
		Description: "ids must list every category (active or not) exactly once; " +
			"they get sortOrder 1..n. Returns all categories in the new order.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *struct{ Body CategoryOrder }) (*listOutput, error) {
		items, err := svc.Reorder(ctx, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getCategory",
		Method:      http.MethodGet,
		Path:        "/api/categories/{id}",
		Summary:     "Get a category",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		item, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createCategory",
		Method:        http.MethodPost,
		Path:          "/api/categories",
		Summary:       "Create a category",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body CategoryInput }) (*itemOutput, error) {
		item, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateCategory",
		Method:      http.MethodPut,
		Path:        "/api/categories/{id}",
		Summary:     "Update a category",
		Description: "Fails with 409 category.stale if the category changed since expectedUpdatedAt.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*itemOutput, error) {
		item, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: item}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteCategory",
		Method:        http.MethodDelete,
		Path:          "/api/categories/{id}",
		Summary:       "Delete a category",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})
}
