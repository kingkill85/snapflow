// Package app assembles the HTTP API from the platform and the feature modules.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"net/netip"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/clientip"
)

const Version = "0.1.0"

// Deps are the shared resources features may use. DB is nil when the API is
// built only to export the OpenAPI document.
type Deps struct {
	DB      *pgxpool.Pool
	Cookies auth.Cookies
	// TrustedProxies may set X-Forwarded-For (see platform/clientip).
	TrustedProxies []netip.Prefix
	// Storage keeps uploaded files; nil when only exporting OpenAPI.
	Storage *files.Storage
	// ProposalGenerations bounds the proposal generations running at once
	// (0: the default, 2).
	ProposalGenerations int
}

// New returns the router with all API routes and the huma API for tests.
func New(deps Deps) (chi.Router, huma.API) {
	apperr.Install()
	// Lists are always arrays in the API, never null.
	huma.DefaultArrayNullable = false

	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Logger, middleware.Recoverer, clientip.Middleware(deps.TrustedProxies))

	cfg := huma.DefaultConfig("SnapFlow API", Version)
	cfg.OpenAPIPath = "/api/openapi"
	cfg.DocsPath = "/api/docs"
	cfg.SchemasPath = "/api/schemas"
	auth.SecuritySchemes(cfg.OpenAPI)
	api := humachi.New(r, cfg)

	// The middleware must be installed before any operation is registered.
	c := newCore(deps.DB)
	api.UseMiddleware(auth.Middleware(api, c.users, deps.Cookies))
	registerHealth(api, deps)
	registerFeatures(api, deps, c)
	return r, api
}

// Bootstrap prepares the database at startup: the distributor tenant and, on
// an installation without an active admin, the first admin.
func Bootstrap(ctx context.Context, db *pgxpool.Pool, b BootstrapConfig) error {
	return newCore(db).users.Bootstrap(ctx, b.DistributorName, b.AdminEmail, b.AdminPassword)
}

type BootstrapConfig struct {
	DistributorName string
	AdminEmail      string
	AdminPassword   string
}

type Health struct {
	Status  string `json:"status" example:"ok"`
	Version string `json:"version"`
}

type healthOutput struct {
	Body Health
}

func registerHealth(api huma.API, deps Deps) {
	huma.Register(api, auth.Public(huma.Operation{
		OperationID: "health",
		Method:      http.MethodGet,
		Path:        "/api/health",
		Summary:     "Liveness and database check",
		Tags:        []string{"system"},
	}), func(ctx context.Context, _ *struct{}) (*healthOutput, error) {
		if err := deps.DB.Ping(ctx); err != nil {
			slog.ErrorContext(ctx, "health: database ping", "error", err)
			return nil, apperr.New(http.StatusServiceUnavailable, "server.database_unavailable", "database unavailable")
		}
		out := &healthOutput{}
		out.Body.Status = "ok"
		out.Body.Version = Version
		return out, nil
	})
}
