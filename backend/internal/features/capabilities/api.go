package capabilities

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type listInput struct {
	IncludeInactive bool `query:"includeInactive" doc:"Also list inactive entries"`
}

// Order is the body of a reorder: every id, in the new order.
type Order struct {
	IDs []uuid.UUID `json:"ids" maxItems:"10000" doc:"Every id, in the new order"`
}

type LoadTypeList struct {
	Items []LoadType `json:"items"`
}

type OutputKindList struct {
	Items []OutputKind `json:"items"`
}

type CatalogFieldList struct {
	Items []CatalogField `json:"items"`
}

type MeaningList struct {
	Items []MeaningSpec `json:"items"`
}

type body[T any] struct {
	Body T
}

type update[T any] struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body T
}

// Register adds the endpoints of load types, output kinds and catalog
// fields. Handlers only translate HTTP to service calls.
func Register(api huma.API, svc *Service) {
	registerCRUD(api, crud[LoadType, LoadTypeInput, LoadTypeUpdate, LoadTypeList]{
		tag: "load-types", path: "/api/load-types", one: "LoadType", many: "LoadTypes", what: "load type",
		list: func(ctx context.Context, all bool) (LoadTypeList, error) {
			items, err := svc.LoadTypes(ctx, all)
			return LoadTypeList{Items: items}, err
		},
		get: svc.LoadType, create: svc.CreateLoadType, update: svc.UpdateLoadType, delete: svc.DeleteLoadType,
		reorder: func(ctx context.Context, ids []uuid.UUID) (LoadTypeList, error) {
			items, err := svc.ReorderLoadTypes(ctx, ids)
			return LoadTypeList{Items: items}, err
		},
	})
	registerCRUD(api, crud[OutputKind, OutputKindInput, OutputKindUpdate, OutputKindList]{
		tag: "output-kinds", path: "/api/output-kinds", one: "OutputKind", many: "OutputKinds", what: "output kind",
		list: func(ctx context.Context, all bool) (OutputKindList, error) {
			items, err := svc.OutputKinds(ctx, all)
			return OutputKindList{Items: items}, err
		},
		get: svc.OutputKind, create: svc.CreateOutputKind, update: svc.UpdateOutputKind, delete: svc.DeleteOutputKind,
		reorder: func(ctx context.Context, ids []uuid.UUID) (OutputKindList, error) {
			items, err := svc.ReorderOutputKinds(ctx, ids)
			return OutputKindList{Items: items}, err
		},
	})
	registerCRUD(api, crud[CatalogField, CatalogFieldInput, CatalogFieldUpdate, CatalogFieldList]{
		tag: "catalog-fields", path: "/api/catalog-fields", one: "CatalogField", many: "CatalogFields", what: "catalog field",
		list: func(ctx context.Context, _ bool) (CatalogFieldList, error) {
			items, err := svc.Fields(ctx)
			return CatalogFieldList{Items: items}, err
		},
		get: svc.Field, create: svc.CreateField, update: svc.UpdateField, delete: svc.DeleteField,
		reorder: func(ctx context.Context, ids []uuid.UUID) (CatalogFieldList, error) {
			items, err := svc.ReorderFields(ctx, ids)
			return CatalogFieldList{Items: items}, err
		},
	})

	huma.Register(api, huma.Operation{
		OperationID: "listCatalogFieldMeanings",
		Method:      http.MethodGet,
		Path:        "/api/catalog-field-meanings",
		Summary:     "List the meanings a catalog field can have",
		Description: "With their parameters (output kind, load type) and the value types each accepts.",
		Tags:        []string{"catalog-fields"},
	}, func(ctx context.Context, _ *struct{}) (*body[MeaningList], error) {
		if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
			return nil, err
		}
		return &body[MeaningList]{Body: MeaningList{Items: Meanings}}, nil
	})
}

type crud[T, In, Up, List any] struct {
	tag, path, one, many, what string
	list                       func(context.Context, bool) (List, error)
	get                        func(context.Context, uuid.UUID) (T, error)
	create                     func(context.Context, In) (T, error)
	update                     func(context.Context, uuid.UUID, Up) (T, error)
	delete                     func(context.Context, uuid.UUID) error
	reorder                    func(context.Context, []uuid.UUID) (List, error)
}

func registerCRUD[T, In, Up, List any](api huma.API, c crud[T, In, Up, List]) {
	tags := []string{c.tag}
	huma.Register(api, huma.Operation{
		OperationID: "list" + c.many, Method: http.MethodGet, Path: c.path, Summary: "List " + c.what + "s", Tags: tags,
		Description: "In catalog order (sortOrder, then key).",
	}, func(ctx context.Context, in *listInput) (*body[List], error) {
		out, err := c.list(ctx, in.IncludeInactive)
		if err != nil {
			return nil, err
		}
		return &body[List]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "reorder" + c.many, Method: http.MethodPut, Path: c.path + "/order", Summary: "Set the order of " + c.what + "s",
		Description: "ids must list every entry (active or not) exactly once.", Tags: tags,
	}, func(ctx context.Context, in *body[Order]) (*body[List], error) {
		out, err := c.reorder(ctx, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &body[List]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "get" + c.one, Method: http.MethodGet, Path: c.path + "/{id}", Summary: "Get a " + c.what, Tags: tags,
	}, func(ctx context.Context, in *idParam) (*body[T], error) {
		out, err := c.get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &body[T]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "create" + c.one, Method: http.MethodPost, Path: c.path, Summary: "Create a " + c.what, Tags: tags,
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *body[In]) (*body[T], error) {
		out, err := c.create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &body[T]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "update" + c.one, Method: http.MethodPut, Path: c.path + "/{id}", Summary: "Update a " + c.what, Tags: tags,
		Description: "Fails with 409 <entity>.stale if it changed since expectedUpdatedAt.",
	}, func(ctx context.Context, in *update[Up]) (*body[T], error) {
		out, err := c.update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &body[T]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "delete" + c.one, Method: http.MethodDelete, Path: c.path + "/{id}", Summary: "Delete a " + c.what, Tags: tags,
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, c.delete(ctx, in.ID)
	})
}
