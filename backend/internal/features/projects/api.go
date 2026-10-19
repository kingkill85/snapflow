package projects

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "projects"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type versionIDParams struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type listInput struct {
	Search   string    `query:"search" maxLength:"200" doc:"Case-insensitive substring of number, name, customer name or company"`
	Status   string    `query:"status" enum:"active,completed,cancelled,all" doc:"Defaults to active; all lists every status"`
	TenantID uuid.UUID `query:"tenantId" format:"uuid" doc:"Only projects of this tenant (callers with tenants.access_all; others always get their own tenant)"`
	Limit    int       `query:"limit" default:"50" minimum:"1" maximum:"200" doc:"Page size, 1-200"`
	Offset   int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type listOutput struct {
	Body ProjectPage
}

type projectOutput struct {
	Body Project
}

type versionOutput struct {
	Body ProjectVersion
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ProjectUpdate
}

type createVersionInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ProjectVersionCreate
}

type updateVersionInput struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      ProjectVersionUpdate
}

// Register adds the project and version endpoints. Handlers only translate
// HTTP to service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listProjects",
		Method:      http.MethodGet,
		Path:        "/api/projects",
		Summary:     "List projects",
		Description: "One page of the projects the caller sees, the most recently changed first.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *listInput) (*listOutput, error) {
		p := ListParams{Search: in.Search, Status: in.Status, Limit: in.Limit, Offset: in.Offset}
		if in.TenantID != uuid.Nil {
			p.TenantID = &in.TenantID
		}
		page, err := svc.List(ctx, p)
		if err != nil {
			return nil, err
		}
		return &listOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getProject",
		Method:      http.MethodGet,
		Path:        "/api/projects/{id}",
		Summary:     "Get a project with its versions",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*projectOutput, error) {
		p, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &projectOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createProject",
		Method:        http.MethodPost,
		Path:          "/api/projects",
		Summary:       "Create a project",
		Description:   "The project gets the next number of its tenant and one version, V1.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body ProjectCreate }) (*projectOutput, error) {
		p, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &projectOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateProject",
		Method:      http.MethodPut,
		Path:        "/api/projects/{id}",
		Summary:     "Update a project",
		Description: "A completed or cancelled project is read-only (409 project.read_only) except for an update " +
			"that sets it back to active.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *updateInput) (*projectOutput, error) {
		p, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &projectOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteProject",
		Method:        http.MethodDelete,
		Path:          "/api/projects/{id}",
		Summary:       "Delete a project with its versions",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createProjectVersion",
		Method:        http.MethodPost,
		Path:          "/api/projects/{id}/versions",
		Summary:       "Add a version",
		Description:   "A full copy of sourceVersionId, or an empty version without it.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createVersionInput) (*versionOutput, error) {
		v, err := svc.CreateVersion(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &versionOutput{Body: v}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateProjectVersion",
		Method:      http.MethodPut,
		Path:        "/api/projects/{id}/versions/{versionId}",
		Summary:     "Rename a version or change its notes",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateVersionInput) (*versionOutput, error) {
		v, err := svc.UpdateVersion(ctx, in.ID, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &versionOutput{Body: v}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteProjectVersion",
		Method:        http.MethodDelete,
		Path:          "/api/projects/{id}/versions/{versionId}",
		Summary:       "Delete a version",
		Description:   "The last version cannot be deleted (409 project_version.last); delete the project instead.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *versionIDParams) (*struct{}, error) {
		return nil, svc.DeleteVersion(ctx, in.ID, in.VersionID)
	})

	registerRates(api, svc)
}

type refreshRateInput struct {
	ID   uuid.UUID            `path:"id" format:"uuid"`
	Body *ExchangeRateRefresh `required:"false"`
}

type setRateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ExchangeRateSet
}

func registerRates(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listCurrencies",
		Method:      http.MethodGet,
		Path:        "/api/currencies",
		Summary:     "List the currencies a project may use",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *struct {
		TenantID uuid.UUID `query:"tenantId" format:"uuid" doc:"Whose recently used currencies to list (default: the caller's tenant)"`
	}) (*struct{ Body CurrencyList }, error) {
		var tenant *uuid.UUID
		if in.TenantID != uuid.Nil {
			tenant = &in.TenantID
		}
		l, err := svc.Currencies(ctx, tenant)
		if err != nil {
			return nil, err
		}
		return &struct{ Body CurrencyList }{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getExchangeRate",
		Method:      http.MethodGet,
		Path:        "/api/exchange-rates/{currency}",
		Summary:     "Get the online provider's current rate of a currency",
		Description: "Cached for an hour; 503 exchange_rate.unavailable when the provider is not reachable and no rates of the last 24 hours are cached.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *struct {
		Currency string `path:"currency" pattern:"^[A-Z]{3}$"`
	}) (*struct{ Body ExchangeRate }, error) {
		r, err := svc.ExchangeRate(ctx, in.Currency)
		if err != nil {
			return nil, err
		}
		return &struct{ Body ExchangeRate }{Body: r}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "refreshProjectExchangeRate",
		Method:      http.MethodPost,
		Path:        "/api/projects/{id}/exchange-rate/refresh",
		Summary:     "Store the online provider's current rate in a project",
		Description: "Non-USD, active projects only (409 project.exchange_rate_usd, project.read_only). The rate is marked online with the provider's date.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *refreshRateInput) (*projectOutput, error) {
		var currency string
		if in.Body != nil {
			currency = in.Body.Currency
		}
		p, err := svc.RefreshRate(ctx, in.ID, currency)
		if err != nil {
			return nil, err
		}
		return &projectOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "setProjectExchangeRate",
		Method:      http.MethodPut,
		Path:        "/api/projects/{id}/exchange-rate",
		Summary:     "Enter a project's rate by hand",
		Description: "Non-USD, active projects only. The rate is marked manual with today's date and never replaced automatically.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *setRateInput) (*projectOutput, error) {
		p, err := svc.SetRate(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &projectOutput{Body: p}, nil
	})
}
