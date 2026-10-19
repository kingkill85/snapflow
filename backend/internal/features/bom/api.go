package bom

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "bom"

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type lineParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
}

type bomOutput struct{ Body BOM }
type pricingOutput struct{ Body Pricing }
type totalsOutput struct{ Body Totals }
type lineOutput struct{ Body ManualLine }
type linesOutput struct{ Body []ManualLine }
type changesOutput struct{ Body CatalogChanges }
type applyOutput struct{ Body ApplyResult }

type pricingInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      PricingUpdate
}

type previewInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      PricingInput
}

type createLineInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      ManualLineInput
}

type updateLineInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	ID        uuid.UUID `path:"id" format:"uuid"`
	Body      ManualLineUpdate
}

type orderInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      struct {
		IDs []uuid.UUID `json:"ids" doc:"Every manual line of the version, in the new order"`
	}
}

type applyInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      ApplyInput
}

func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "getBom",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/bom",
		Summary:     "Get the bill of materials of a version",
		Description: "Computed from the placements of the version's plans (not existing ones) and its manual lines, " +
			"priced from the version's snapshots, with groups, totals, pricing and manual lines.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *versionParam) (*bomOutput, error) {
		b, err := svc.Get(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &bomOutput{Body: b}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getPricing",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/pricing",
		Summary:     "Get the pricing of a version",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*pricingOutput, error) {
		p, err := svc.GetPricing(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &pricingOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updatePricing",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/pricing",
		Summary:     "Save the pricing of a version",
		Description: "Returns the new BOM. 409 pricing.stale when it changed since expectedUpdatedAt.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *pricingInput) (*bomOutput, error) {
		b, err := svc.SavePricing(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &bomOutput{Body: b}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "previewPricing",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/pricing/preview",
		Summary:     "Totals for unsaved pricing values",
		Description: "Validates like a save and returns the totals the version would have; nothing is saved.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *previewInput) (*totalsOutput, error) {
		t, err := svc.PreviewPricing(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &totalsOutput{Body: t}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listManualLines",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/manual-lines",
		Summary:     "List the manual lines of a version",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*linesOutput, error) {
		l, err := svc.ListManualLines(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &linesOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createManualLine",
		Method:        http.MethodPost,
		Path:          "/api/versions/{versionId}/manual-lines",
		Summary:       "Add a manual line",
		Description:   "A catalog line (variantId; snapshot taken at the variant's first appearance) or a free-text line (name, unitPrice).",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createLineInput) (*lineOutput, error) {
		l, err := svc.CreateManualLine(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &lineOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateManualLine",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/manual-lines/{id}",
		Summary:     "Change a manual line",
		Description: "409 bom.line_stale when it changed since expectedUpdatedAt.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateLineInput) (*lineOutput, error) {
		l, err := svc.UpdateManualLine(ctx, in.VersionID, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &lineOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteManualLine",
		Method:        http.MethodDelete,
		Path:          "/api/versions/{versionId}/manual-lines/{id}",
		Summary:       "Delete a manual line",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *lineParam) (*struct{}, error) {
		return nil, svc.DeleteManualLine(ctx, in.VersionID, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "reorderManualLines",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/manual-lines/order",
		Summary:     "Set the order of the manual lines",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *orderInput) (*linesOutput, error) {
		l, err := svc.ReorderManualLines(ctx, in.VersionID, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &linesOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getCatalogChanges",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/catalog-changes",
		Summary:     "Preview \"Update from catalog\"",
		Description: "The used snapshots that differ from the catalog (or whose variant was deleted), field by field, " +
			"with the effect on the USD grand total.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *versionParam) (*changesOutput, error) {
		c, err := svc.CatalogChanges(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &changesOutput{Body: c}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "applyCatalogChanges",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/catalog-changes/apply",
		Summary:     "Update snapshots from the catalog",
		Description: "Re-snapshots the selected variants (or all); deleted variants and unchanged snapshots are skipped.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *applyInput) (*applyOutput, error) {
		r, err := svc.ApplyCatalogChanges(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &applyOutput{Body: r}, nil
	})
}
