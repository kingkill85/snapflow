package tenants

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

type letterheadOutput struct {
	Body Letterhead
}

type letterheadInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body LetterheadInput
}

type logoForm struct {
	Image huma.FormFile `form:"image" required:"true" doc:"JPEG, PNG or WebP image, at most 5 MB"`
}

type logoInput struct {
	ID      uuid.UUID `path:"id" format:"uuid"`
	RawBody huma.MultipartFormFiles[logoForm]
}

type fileOutput struct {
	Body files.File
}

const tag = "tenants"

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type listInput struct {
	IncludeArchived bool `query:"includeArchived" doc:"Also list archived tenants"`
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body TenantInput
}

type itemOutput struct {
	Body Tenant
}

type TenantList struct {
	Items []Tenant `json:"items"`
}

type listOutput struct {
	Body TenantList
}

// Register adds the tenant endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listTenants",
		Method:      http.MethodGet,
		Path:        "/api/tenants",
		Summary:     "List tenants",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *listInput) (*listOutput, error) {
		items, err := svc.List(ctx, in.IncludeArchived)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getTenant",
		Method:      http.MethodGet,
		Path:        "/api/tenants/{id}",
		Summary:     "Get a tenant",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		t, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: t}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createTenant",
		Method:        http.MethodPost,
		Path:          "/api/tenants",
		Summary:       "Create a partner tenant",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body TenantInput }) (*itemOutput, error) {
		t, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: t}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateTenant",
		Method:      http.MethodPut,
		Path:        "/api/tenants/{id}",
		Summary:     "Update a tenant",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*itemOutput, error) {
		t, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: t}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "deleteTenant",
		Method:      http.MethodDelete,
		Path:        "/api/tenants/{id}",
		Summary:     "Delete a partner tenant and its users, or archive it when it has projects",
		Description: "A tenant without projects is deleted with its users. A tenant with projects (projectCount) is " +
			"deactivated and archived instead, keeping its users and projects; an archived tenant with projects " +
			"cannot be deleted (409 tenant.has_projects).",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "getTenantLetterhead",
		Method:      http.MethodGet,
		Path:        "/api/tenants/{id}/letterhead",
		Summary:     "Get a tenant's letterhead",
		Description: "Admins for every tenant, a tenant admin for their own (tenants.profile).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*letterheadOutput, error) {
		l, err := svc.GetLetterhead(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &letterheadOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateTenantLetterhead",
		Method:      http.MethodPut,
		Path:        "/api/tenants/{id}/letterhead",
		Summary:     "Change a tenant's letterhead",
		Description: "Replaces every field (empty clears). Admins for every tenant, a tenant admin for their own (tenants.profile).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *letterheadInput) (*letterheadOutput, error) {
		l, err := svc.UpdateLetterhead(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &letterheadOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "uploadTenantLogo",
		Method:      http.MethodPost,
		Path:        "/api/tenants/{id}/logo",
		Summary:     "Upload a logo for a tenant's letterhead",
		Description: "Multipart field `image` (JPEG, PNG or WebP, at most 5 MB); stored in the tenant's scope. Set it as " +
			"the letterhead's logoFileId to use it.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
		Middlewares:   huma.Middlewares{files.LimitUpload(auth.PermTenantsProfile, LogoMaxSize)},
	}, func(ctx context.Context, in *logoInput) (*fileOutput, error) {
		form := in.RawBody.Data()
		defer func() { _ = form.Image.Close() }()
		f, err := svc.UploadLogo(ctx, in.ID, form.Image)
		if err != nil {
			return nil, err
		}
		return &fileOutput{Body: f}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "restoreTenant",
		Method:      http.MethodPost,
		Path:        "/api/tenants/{id}/restore",
		Summary:     "Restore an archived tenant",
		Description: "The tenant leaves the archive and stays inactive until it is activated.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		t, err := svc.Restore(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: t}, nil
	})
}
