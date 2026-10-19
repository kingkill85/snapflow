package roomtemplates

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "room-templates"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type listInput struct {
	IncludeInactive bool `query:"includeInactive" doc:"Also list inactive templates"`
}

// RoomTemplateOrder is the body of a reorder: every id, in the new order.
type RoomTemplateOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"10000" doc:"Every id, in the new order"`
}

type RoomTemplateList struct {
	Items []RoomTemplate `json:"items"`
}

type body[T any] struct {
	Body T
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body RoomTemplateUpdate
}

// Register adds the room template endpoints. Handlers only translate HTTP
// to service calls.
func Register(api huma.API, svc *Service) {
	tags := []string{tag}
	huma.Register(api, huma.Operation{
		OperationID: "listRoomTemplates", Method: http.MethodGet, Path: "/api/room-templates", Summary: "List room templates",
		Description: "In order (sortOrder, then key). Needs projects.read or catalog.read.", Tags: tags,
	}, func(ctx context.Context, in *listInput) (*body[RoomTemplateList], error) {
		items, err := svc.List(ctx, in.IncludeInactive)
		if err != nil {
			return nil, err
		}
		return &body[RoomTemplateList]{Body: RoomTemplateList{Items: items}}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "reorderRoomTemplates", Method: http.MethodPut, Path: "/api/room-templates/order",
		Summary: "Set the order of room templates", Description: "ids must list every template (active or not) exactly once.", Tags: tags,
	}, func(ctx context.Context, in *body[RoomTemplateOrder]) (*body[RoomTemplateList], error) {
		items, err := svc.Reorder(ctx, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &body[RoomTemplateList]{Body: RoomTemplateList{Items: items}}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "getRoomTemplate", Method: http.MethodGet, Path: "/api/room-templates/{id}", Summary: "Get a room template", Tags: tags,
	}, func(ctx context.Context, in *idParam) (*body[RoomTemplate], error) {
		out, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &body[RoomTemplate]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "createRoomTemplate", Method: http.MethodPost, Path: "/api/room-templates", Summary: "Create a room template",
		Tags: tags, DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *body[RoomTemplateInput]) (*body[RoomTemplate], error) {
		out, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &body[RoomTemplate]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "updateRoomTemplate", Method: http.MethodPut, Path: "/api/room-templates/{id}", Summary: "Update a room template",
		Description: "Replaces the lines. Fails with 409 room_template.stale if it changed since expectedUpdatedAt.", Tags: tags,
	}, func(ctx context.Context, in *updateInput) (*body[RoomTemplate], error) {
		out, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &body[RoomTemplate]{Body: out}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "deleteRoomTemplate", Method: http.MethodDelete, Path: "/api/room-templates/{id}", Summary: "Delete a room template",
		Tags: tags, DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})
}
