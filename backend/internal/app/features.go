package app

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	filesstore "github.com/kingkill85/snapflow/backend/internal/features/files/store"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	functiontypesstore "github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	tenantsstore "github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	// scaffold:imports
)

// core holds the services the platform itself needs: users authenticate every
// request, tenants back users. Other features may depend on them.
type core struct {
	tenants *tenants.Service
	users   *users.Service
}

func newCore(db *pgxpool.Pool) core {
	t := tenants.NewService(tenantsstore.New(db))
	return core{tenants: t, users: users.NewService(db, t)}
}

// registerFeatures is the one place where feature modules are wired in.
// `make feature` adds new features above the marker.
func registerFeatures(api huma.API, deps Deps, c core) {
	tenants.Register(api, c.tenants)
	users.Register(api, c.users, deps.Cookies)
	functiontypes.Register(api, functiontypes.NewService(functiontypesstore.New(deps.DB)))
	productTypes := producttypes.NewService(deps.DB)
	producttypes.Register(api, productTypes)
	fileSvc := files.NewService(filesstore.New(deps.DB), deps.Storage)
	files.Register(api, fileSvc)
	products.Register(api, products.NewService(deps.DB, productTypes, fileSvc))
	// scaffold:features
}
