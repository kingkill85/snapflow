// Package app assembles the HTTP API from the platform and the feature modules.
package app

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

const Version = "0.1.0"

// Deps are the shared resources features may use. DB is nil when the API is
// built only to export the OpenAPI document.
type Deps struct {
	DB *pgxpool.Pool
}

// New returns the router with all API routes and the huma API for tests.
func New(deps Deps) (chi.Router, huma.API) {
	apperr.Install()
	// Lists are always arrays in the API, never null.
	huma.DefaultArrayNullable = false

	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Logger, middleware.Recoverer)

	cfg := huma.DefaultConfig("SnapFlow API", Version)
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "/api/docs"
	cfg.SchemasPath = "/api/schemas"
	api := humachi.New(r, cfg)

	registerHealth(api, deps)
	registerFeatures(api, deps)
	return r, api
}

type Health struct {
	Status  string `json:"status" example:"ok"`
	Version string `json:"version"`
}

type healthOutput struct {
	Body Health
}

func registerHealth(api huma.API, deps Deps) {
	huma.Register(api, huma.Operation{
		OperationID: "health",
		Method:      http.MethodGet,
		Path:        "/api/health",
		Summary:     "Liveness and database check",
		Tags:        []string{"system"},
	}, func(ctx context.Context, _ *struct{}) (*healthOutput, error) {
		if err := deps.DB.Ping(ctx); err != nil {
			return nil, apperr.New(http.StatusServiceUnavailable, "server.database_unavailable", err.Error())
		}
		out := &healthOutput{}
		out.Body.Status = "ok"
		out.Body.Version = Version
		return out, nil
	})
}
