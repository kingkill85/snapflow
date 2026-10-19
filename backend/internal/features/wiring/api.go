package wiring

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "wiring"

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type connectionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
}

type batchParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	BatchID   uuid.UUID `path:"batchId" format:"uuid"`
}

type connectionsOutput struct{ Body Connections }

type connectionResultOutput struct{ Body ConnectionResult }

type removedOutput struct{ Body Removed }

type checksOutput struct{ Body Checks }

type previewOutput struct{ Body AutoConnectPreview }

type applyOutput struct{ Body AutoConnectResult }

type connectInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      ConnectionInput
}

type updateInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
	Body      ConnectionUpdate
}

type disconnectInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      DisconnectInput
}

type previewInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      AutoConnectScope
}

type applyInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      AutoConnectApply
}

// Register adds the connection, checks and auto-connect endpoints. Handlers
// only translate HTTP to service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	registerViews(api, svc)
	huma.Register(api, huma.Operation{
		OperationID: "listConnections",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/connections",
		Summary:     "List the connections of a version",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*connectionsOutput, error) {
		out, err := svc.List(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &connectionsOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createConnection",
		Method:        http.MethodPost,
		Path:          "/api/versions/{versionId}/connections",
		Summary:       "Connect units of a need to a channel",
		Description:   "Pinned. A broken rule is a 422 field error connection.<code>; warnings (limit_unknown, min_load) come with the result.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *connectInput) (*connectionResultOutput, error) {
		out, err := svc.Connect(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &connectionResultOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateConnection",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/connections/{id}",
		Summary:     "Change the units of a connection or move it to another channel",
		Description: "The connection becomes pinned and leaves its auto-connect batch.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*connectionResultOutput, error) {
		out, err := svc.Update(ctx, in.VersionID, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &connectionResultOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteConnection",
		Method:        http.MethodDelete,
		Path:          "/api/versions/{versionId}/connections/{id}",
		Summary:       "Remove a connection",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *connectionParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.VersionID, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "disconnect",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/connections/disconnect",
		Summary:     "Remove every connection of a need or of a channel",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *disconnectInput) (*removedOutput, error) {
		out, err := svc.Disconnect(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &removedOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getChecks",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/checks",
		Summary:     "Evaluate a version",
		Description: "Zone coverage, board channels and TE, bus lines, gateways and the findings; computed on demand.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*checksOutput, error) {
		out, err := svc.Checks(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &checksOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "previewAutoConnect",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/auto-connect/preview",
		Summary:     "Preview auto-connect",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *previewInput) (*previewOutput, error) {
		out, err := svc.Preview(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &previewOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "applyAutoConnect",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/auto-connect/apply",
		Summary:     "Apply auto-connect",
		Description: "Makes the previewed connections as one batch; 409 auto_connect.changed when anything changed since the preview.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *applyInput) (*applyOutput, error) {
		out, err := svc.Apply(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &applyOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "undoAutoConnect",
		Method:      http.MethodDelete,
		Path:        "/api/versions/{versionId}/auto-connect/{batchId}",
		Summary:     "Undo an auto-connect batch",
		Description: "Removes the connections still from the batch (changed ones left it).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *batchParam) (*removedOutput, error) {
		out, err := svc.Undo(ctx, in.VersionID, in.BatchID)
		if err != nil {
			return nil, err
		}
		return &removedOutput{Body: out}, nil
	})
}

type wiringOutput struct{ Body Wiring }

type candidatesInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      CandidatesInput
}

type candidatesOutput struct{ Body Candidates }

// registerViews adds the wiring view and the connect candidates.
func registerViews(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "getWiring",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/wiring",
		Summary:     "Channels of every item and needs with their connections",
		Description: "The data the editors and the Checks tab show connections with (labels, channel numbering D387).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*wiringOutput, error) {
		out, err := svc.Wiring(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &wiringOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "connectionCandidates",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/connections/candidates",
		Summary:     "Channels a need can be connected to, or needs a channel can take",
		Description: "Give a need (needPlanId, needId) or a channel (targetPlanId, targetItemId, outputKindId, channelNo). Each candidate has the units it takes or the first rule it breaks. Read-only: allowed on completed projects.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *candidatesInput) (*candidatesOutput, error) {
		out, err := svc.Candidates(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &candidatesOutput{Body: out}, nil
	})
}
