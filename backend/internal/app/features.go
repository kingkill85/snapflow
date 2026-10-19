package app

import (
	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/roomtemplates"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	tenantsstore "github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
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
	functionTypeSvc := functiontypes.NewService(deps.DB)
	functiontypes.Register(api, functionTypeSvc)
	productTypes := producttypes.NewService(deps.DB)
	producttypes.Register(api, productTypes)
	capSvc := capabilities.NewService(deps.DB)
	capabilities.Register(api, capSvc)
	roomtemplates.Register(api, roomtemplates.NewService(deps.DB, functionTypeSvc, capSvc))
	cats := categories.NewService(deps.DB, capSvc)
	capSvc.OnFieldUsage(cats.FieldUsers)
	categories.Register(api, cats)
	fileSvc := files.NewService(deps.DB, deps.Storage)
	files.Register(api, fileSvc)
	c.tenants.UseFiles(fileSvc)
	productSvc := products.NewService(deps.DB, productTypes, cats, fileSvc, capSvc)
	products.Register(api, productSvc)
	importSvc := imports.NewService(deps.DB, productTypes, cats, productSvc, fileSvc, c.users, capSvc)
	imports.Register(api, importSvc)
	capSvc.OnProfileRefs(importSvc.ProfilesLinkingField)
	projectSvc := projects.NewService(deps.DB, productTypes, c.tenants)
	if deps.ExchangeRates != nil {
		projectSvc.UseExchangeRates(deps.ExchangeRates, deps.ExchangeRateMaxAgeDays)
	}
	c.tenants.UseProjects(projectSvc)
	projects.Register(api, projectSvc)
	planSvc := plans.NewService(deps.DB, projectSvc, productSvc, fileSvc, c.users, functionTypeSvc, capSvc)
	projectSvc.OnCopyVersion(planSvc.CopyVersion)
	for _, c := range deps.PlanCopiers {
		planSvc.OnCopyPlans(c)
	}
	plans.Register(api, planSvc)
	networkSvc := networks.NewService(deps.DB, projectSvc, planSvc, productSvc, productTypes)
	networks.Register(api, networkSvc)
	networks.RegisterAddresses(api, networkSvc)
	wiring.Register(api, wiring.NewService(deps.DB, projectSvc, planSvc, productSvc, productTypes, capSvc, functionTypeSvc, networkSvc))
	bomSvc := bom.NewService(deps.DB, projectSvc, planSvc, productSvc)
	bom.Register(api, bomSvc)
	proposalSvc := proposals.NewService(deps.DB, projectSvc, bomSvc, planSvc, c.tenants, fileSvc, c.users,
		document.NewRegistry(docx.Exporter{}))
	if deps.ProposalGenerations > 0 {
		proposalSvc.SetConcurrency(deps.ProposalGenerations)
	}
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
