package readiness

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

type output struct {
	Body Readiness
}

// Register adds GET /api/catalog/readiness. The handler only translates
// HTTP to the service call.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "getCatalogReadiness",
		Method:      http.MethodGet,
		Path:        "/api/catalog/readiness",
		Summary:     "Catalog readiness",
		Tags:        []string{"catalog-readiness"},
		Description: "What SnapFlow still needs before each active system works in a project, and what concerns the whole catalog. Computed on request; inactive products, categories and systems are skipped.",
	}, func(ctx context.Context, _ *struct{}) (*output, error) {
		r, err := svc.Readiness(ctx)
		if err != nil {
			return nil, err
		}
		return &output{Body: r}, nil
	})
}
