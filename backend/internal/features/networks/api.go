package networks

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "networks"

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type lineParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
}

type linesOutput struct{ Body []BusLine }

type lineOutput struct{ Body BusLine }

type networksOutput struct{ Body Networks }

type createLineInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      BusLineInput
}

type updateLineInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
	Body      BusLineUpdate
}

// BusLineOrder is the new order of a version's bus lines.
type BusLineOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"1000" doc:"Every line of the version exactly once, in the new order"`
}

type orderInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      BusLineOrder
}

type assignmentsInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      AssignmentsInput
}

// Register adds the network endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listBusLines",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/bus-lines",
		Summary:     "List the bus lines of a version",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*linesOutput, error) {
		out, err := svc.ListBusLines(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &linesOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createBusLine",
		Method:        http.MethodPost,
		Path:          "/api/versions/{versionId}/bus-lines",
		Summary:       "Add a bus line",
		Description:   "To a bus system (product type with topology bus; 422 bus_line.not_bus_system otherwise), after the version's last line.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createLineInput) (*lineOutput, error) {
		out, err := svc.CreateBusLine(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &lineOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateBusLine",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/bus-lines/{id}",
		Summary:     "Rename a bus line or change its address",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateLineInput) (*lineOutput, error) {
		out, err := svc.UpdateBusLine(ctx, in.VersionID, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &lineOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteBusLine",
		Method:        http.MethodDelete,
		Path:          "/api/versions/{versionId}/bus-lines/{id}",
		Summary:       "Delete a bus line",
		Description:   "Refused while devices are explicitly assigned to it (409 bus_line.in_use), and for the last line of its system while devices of that system are on the version's plans (409 bus_line.last_with_devices, params count; D451).",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *lineParam) (*struct{}, error) {
		return nil, svc.DeleteBusLine(ctx, in.VersionID, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "reorderBusLines",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/bus-lines/order",
		Summary:     "Reorder the bus lines of a version",
		Description: "ids must list every line of the version exactly once (422 bus_line.order_mismatch). The first line of a system is its default line.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *orderInput) (*linesOutput, error) {
		out, err := svc.ReorderBusLines(ctx, in.VersionID, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &linesOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getNetworks",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/networks",
		Summary:     "Get the bus lines and gateways of a version",
		Description: "Bus systems with their lines and members, wireless systems with their gateways and devices; " +
			"default and explicit (pinned) assignments. A bus system with members but no line gets its default line " +
			"first when the caller may change the version.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *versionParam) (*networksOutput, error) {
		out, err := svc.Get(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &networksOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "setNetworkAssignments",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/network-assignments",
		Summary:     "Set or clear explicit network assignments",
		Description: "Each entry assigns an item (placement or module) to a bus line or a gateway of its system; both " +
			"targets null clears the assignment (back to the default). Returns the networks.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *assignmentsInput) (*networksOutput, error) {
		out, err := svc.SetAssignments(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &networksOutput{Body: out}, nil
	})
}

type addressesOutput struct{ Body Addresses }

type assignOutput struct{ Body AssignResult }

type setAddressesInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      AddressesInput
}

type assignAddressesInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      AssignInput
}

type clearAddressesInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Auto      bool      `query:"auto" required:"true" doc:"Must be true: removes the automatic addresses (addresses set by hand stay)"`
}

// RegisterAddresses adds the device address endpoints (step 3e).
func RegisterAddresses(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "getAddresses",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/addresses",
		Summary:     "Get the device addresses of a version",
		Description: "Every bus and wireless item with its addressing scheme, line or gateway and address; the line prefixes.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*addressesOutput, error) {
		out, err := svc.GetAddresses(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &addressesOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "setAddresses",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/addresses",
		Summary:     "Set or clear device addresses",
		Description: "Addresses set here are pinned (auto-assign keeps them). Every field empty clears an item's address. Unique per version (422 address.taken).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *setAddressesInput) (*addressesOutput, error) {
		out, err := svc.SetAddresses(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &addressesOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "assignAddresses",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/addresses/assign",
		Summary:     "Assign addresses automatically",
		Description: "KNX and HDL devices of the lines in scope, deterministic (D419); pinned addresses never change.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *assignAddressesInput) (*assignOutput, error) {
		out, err := svc.Assign(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &assignOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "clearAutomaticAddresses",
		Method:      http.MethodDelete,
		Path:        "/api/versions/{versionId}/addresses",
		Summary:     "Remove the automatic addresses",
		Description: "Needs auto=true; addresses set by hand stay.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *clearAddressesInput) (*addressesOutput, error) {
		out, err := svc.ClearAutomatic(ctx, in.VersionID, in.Auto)
		if err != nil {
			return nil, err
		}
		return &addressesOutput{Body: out}, nil
	})
}
