package functiontypes

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "function-types"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body FunctionTypeInput
}

type itemOutput struct {
	Body FunctionType
}

type FunctionTypeList struct {
	Items []FunctionType `json:"items"`
}

type listOutput struct {
	Body FunctionTypeList
}

// Register adds the function type endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listFunctionTypes",
		Method:      http.MethodGet,
		Path:        "/api/function-types",
		Summary:     "List function types",
		Tags:        []string{tag},
	}, func(ctx context.Context, _ *struct{}) (*listOutput, error) {
		items, err := svc.List(ctx)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getFunctionType",
		Method:      http.MethodGet,
		Path:        "/api/function-types/{id}",
		Summary:     "Get a function type",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		ft, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: ft}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createFunctionType",
		Method:        http.MethodPost,
		Path:          "/api/function-types",
		Summary:       "Create a function type",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body FunctionTypeInput }) (*itemOutput, error) {
		ft, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: ft}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateFunctionType",
		Method:      http.MethodPut,
		Path:        "/api/function-types/{id}",
		Summary:     "Update a function type",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*itemOutput, error) {
		ft, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: ft}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteFunctionType",
		Method:        http.MethodDelete,
		Path:          "/api/function-types/{id}",
		Summary:       "Delete a function type",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})
}
