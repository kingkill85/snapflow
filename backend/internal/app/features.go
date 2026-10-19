package app

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	functiontypesstore "github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	tenantsstore "github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/document/docx"
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
	cats := categories.NewService(deps.DB)
	categories.Register(api, cats)
	fileSvc := files.NewService(deps.DB, deps.Storage)
	files.Register(api, fileSvc)
	c.tenants.UseFiles(fileSvc)
	productSvc := products.NewService(deps.DB, productTypes, cats, fileSvc)
	products.Register(api, productSvc)
	importSvc := imports.NewService(deps.DB, productTypes, cats, productSvc, fileSvc, c.users)
	imports.Register(api, importSvc)
	projectSvc := projects.NewService(deps.DB, productTypes, c.tenants)
	c.tenants.UseProjects(projectSvc)
	projects.Register(api, projectSvc)
	planSvc := plans.NewService(deps.DB, projectSvc, productSvc, fileSvc, c.users)
	projectSvc.OnCopyVersion(planSvc.CopyVersion)
	plans.Register(api, planSvc)
	bomSvc := bom.NewService(deps.DB, projectSvc, planSvc, productSvc)
	bom.Register(api, bomSvc)
	proposalSvc := proposals.NewService(deps.DB, projectSvc, bomSvc, planSvc, c.tenants, fileSvc, c.users,
		document.NewRegistry(docx.Exporter{}))
	projectSvc.OnDeleteVersions(proposalSvc.DeleteVersionFiles)
	proposals.Register(api, proposalSvc)
	// Every feature with a file id column answers the files feature's
	// reference check (D269).
	for _, r := range []files.Referencer{productSvc.ReferencedFiles, planSvc.ReferencedFiles, bomSvc.ReferencedFiles,
		c.tenants.ReferencedFiles, proposalSvc.ReferencedFiles, importSvc.ReferencedFiles} {
		fileSvc.OnReferences(r)
	}
	// scaffold:features
}
