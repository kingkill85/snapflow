package users

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/clientip"
)

const (
	tag     = "users"
	authTag = "auth"
)

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type listInput struct {
	TenantID uuid.UUID `query:"tenantId" format:"uuid" doc:"Only users of this tenant (callers who see every tenant)"`
}

type updateInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body UserInput
}

type itemOutput struct {
	Body User
}

type UserList struct {
	Items []User `json:"items"`
}

type listOutput struct {
	Body UserList
}

type meOutput struct {
	Body Me
}

type loginOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
	Body      Me
}

type logoutOutput struct {
	SetCookie http.Cookie `header:"Set-Cookie"`
}

type matrixOutput struct {
	Body RoleMatrix
}

// Register adds the user, session and account endpoints. Handlers only
// translate HTTP to service calls; all rules live in Service.
func Register(api huma.API, svc *Service, cookies auth.Cookies) {
	registerUsers(api, svc)
	registerAccount(api, svc, cookies)
}

func registerUsers(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listUsers",
		Method:      http.MethodGet,
		Path:        "/api/users",
		Summary:     "List users",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *listInput) (*listOutput, error) {
		var tenantID *uuid.UUID
		if in.TenantID != uuid.Nil {
			tenantID = &in.TenantID
		}
		items, err := svc.List(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		out := &listOutput{}
		out.Body.Items = items
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getUser",
		Method:      http.MethodGet,
		Path:        "/api/users/{id}",
		Summary:     "Get a user",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*itemOutput, error) {
		u, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: u}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "createUser",
		Method:        http.MethodPost,
		Path:          "/api/users",
		Summary:       "Create a user",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body UserInput }) (*itemOutput, error) {
		u, err := svc.Create(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: u}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateUser",
		Method:      http.MethodPut,
		Path:        "/api/users/{id}",
		Summary:     "Update a user",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *updateInput) (*itemOutput, error) {
		u, err := svc.Update(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &itemOutput{Body: u}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteUser",
		Method:        http.MethodDelete,
		Path:          "/api/users/{id}",
		Summary:       "Delete a user",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "getRoleMatrix",
		Method:      http.MethodGet,
		Path:        "/api/roles",
		Summary:     "Get the permission matrix",
		Tags:        []string{tag},
	}, func(ctx context.Context, _ *struct{}) (*matrixOutput, error) {
		m, err := svc.Matrix(ctx)
		if err != nil {
			return nil, err
		}
		return &matrixOutput{Body: m}, nil
	})
}

func registerAccount(api huma.API, svc *Service, cookies auth.Cookies) {
	huma.Register(api, auth.Public(huma.Operation{
		OperationID: "login",
		Method:      http.MethodPost,
		Path:        "/api/auth/login",
		Summary:     "Log in and receive a session cookie",
		Tags:        []string{authTag},
	}), func(ctx context.Context, in *struct{ Body LoginInput }) (*loginOutput, error) {
		token, me, err := svc.Login(ctx, in.Body, clientip.FromContext(ctx))
		if err != nil {
			return nil, err
		}
		return &loginOutput{SetCookie: cookies.Session(token), Body: me}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "logout",
		Method:        http.MethodPost,
		Path:          "/api/auth/logout",
		Summary:       "End the current session",
		Tags:          []string{authTag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, _ *struct{}) (*logoutOutput, error) {
		if err := svc.Logout(ctx); err != nil {
			return nil, err
		}
		return &logoutOutput{SetCookie: cookies.Clear()}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "logoutAll",
		Method:        http.MethodPost,
		Path:          "/api/auth/logout-all",
		Summary:       "Sign out everywhere: end all of the caller's sessions, including the current one",
		Tags:          []string{authTag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, _ *struct{}) (*logoutOutput, error) {
		if err := svc.LogoutAll(ctx); err != nil {
			return nil, err
		}
		return &logoutOutput{SetCookie: cookies.Clear()}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getMe",
		Method:      http.MethodGet,
		Path:        "/api/auth/me",
		Summary:     "Get the logged-in user",
		Tags:        []string{authTag},
	}, func(ctx context.Context, _ *struct{}) (*meOutput, error) {
		me, err := svc.Me(ctx)
		if err != nil {
			return nil, err
		}
		return &meOutput{Body: me}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateMe",
		Method:      http.MethodPut,
		Path:        "/api/auth/me",
		Summary:     "Update the logged-in user's profile",
		Tags:        []string{authTag},
	}, func(ctx context.Context, in *struct{ Body ProfileInput }) (*meOutput, error) {
		me, err := svc.UpdateProfile(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &meOutput{Body: me}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "changePassword",
		Method:        http.MethodPut,
		Path:          "/api/auth/me/password",
		Summary:       "Change the logged-in user's password; ends their other sessions",
		Tags:          []string{authTag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *struct{ Body PasswordInput }) (*struct{}, error) {
		return nil, svc.ChangePassword(ctx, in.Body)
	})
}
