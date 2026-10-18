package users_test

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app"
	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	tenantsstore "github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Two admins remove each other at the same time. Each request alone is
// allowed (the other admin remains), so only the transaction and row locks
// keep the installation from losing its last admin. The service is called
// directly so both callers are certainly still admins when they start.
func TestLastAdminSurvivesConcurrentChanges(t *testing.T) {
	api := apptest.New(t)
	svc := users.NewService(api.DB, tenants.NewService(tenantsstore.New(api.DB)))
	second := api.NewUser(api.Distributor, auth.RoleAdmin)
	admins := []apptest.Session{api.Admin, second}

	ops := map[string]func(ctx context.Context, target apptest.Session) error{
		"demote": func(ctx context.Context, target apptest.Session) error {
			_, err := svc.Update(ctx, target.UserID, users.UserInput{
				Email: target.Email, Role: auth.RoleUser, TenantID: &target.TenantID, IsActive: true,
			})
			return err
		},
		"deactivate": func(ctx context.Context, target apptest.Session) error {
			_, err := svc.Update(ctx, target.UserID, users.UserInput{
				Email: target.Email, Role: auth.RoleAdmin, TenantID: &target.TenantID, IsActive: false,
			})
			return err
		},
		"delete": func(ctx context.Context, target apptest.Session) error {
			return svc.Delete(ctx, target.UserID)
		},
	}
	for name, op := range ops {
		t.Run(name, func(t *testing.T) {
			for round := range 10 {
				restoreAdmins(t, api, admins)
				errs := make([]error, 2)
				start := make(chan struct{})
				var wg sync.WaitGroup
				for i, actor := range admins {
					wg.Add(1)
					go func() {
						defer wg.Done()
						ctx := auth.WithActor(context.Background(), auth.Actor{
							UserID: actor.UserID, TenantID: actor.TenantID, Role: auth.RoleAdmin,
						})
						<-start
						errs[i] = op(ctx, admins[1-i])
					}()
				}
				close(start)
				wg.Wait()

				ok, lastAdmin := 0, 0
				for _, err := range errs {
					var ae *apperr.Error
					switch {
					case err == nil:
						ok++
					case errors.As(err, &ae) && ae.Status == http.StatusConflict && ae.Code == "user.last_admin":
						lastAdmin++
					default:
						t.Fatalf("round %d: unexpected error %v", round, err)
					}
				}
				if ok != 1 || lastAdmin != 1 {
					t.Fatalf("round %d: %d succeeded, %d refused: %v", round, ok, lastAdmin, errs)
				}
				if n := countActiveAdmins(t, api); n != 1 {
					t.Fatalf("round %d: %d active admins", round, n)
				}
			}
		})
	}
}

// restoreAdmins makes the sessions' users active admins again (re-creating
// deleted ones with the same id).
func restoreAdmins(t *testing.T, api *apptest.API, admins []apptest.Session) {
	t.Helper()
	for _, a := range admins {
		if _, err := api.DB.Exec(context.Background(), `
INSERT INTO users (id, tenant_id, email, password_hash, role, is_active)
VALUES ($1, $2, $3, 'x', 'admin', true)
ON CONFLICT (id) DO UPDATE SET role = 'admin', is_active = true`, a.UserID, a.TenantID, a.Email); err != nil {
			t.Fatal(err)
		}
	}
}

func countActiveAdmins(t *testing.T, api *apptest.API) int {
	t.Helper()
	var n int
	if err := api.DB.QueryRow(context.Background(),
		`SELECT count(*) FROM users WHERE role = 'admin' AND is_active`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func bootstrap(t *testing.T, api *apptest.API, email, password string) {
	t.Helper()
	if err := app.Bootstrap(context.Background(), api.DB, app.BootstrapConfig{
		DistributorName: "Distributor", AdminEmail: email, AdminPassword: password,
	}); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
}

func deactivateAdmins(t *testing.T, api *apptest.API) {
	t.Helper()
	if _, err := api.DB.Exec(context.Background(), `UPDATE users SET is_active = false WHERE role = 'admin'`); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrap(t *testing.T) {
	t.Run("idempotent", func(t *testing.T) {
		api := apptest.New(t)
		bootstrap(t, api, apptest.AdminEmail, "another-password")
		bootstrap(t, api, apptest.AdminEmail, "another-password")
		if n := countActiveAdmins(t, api); n != 1 {
			t.Fatalf("%d admins", n)
		}
		// Nothing was reset: the old password and session still work.
		api.Login(apptest.AdminEmail, apptest.Password)
		if resp := api.Get("/api/auth/me", api.Admin.Cookie); resp.Code != http.StatusOK {
			t.Errorf("session after bootstrap: got %d", resp.Code)
		}
	})

	t.Run("skipped with an active admin", func(t *testing.T) {
		api := apptest.New(t)
		bootstrap(t, api, "other@example.com", "another-password")
		if code := login(api, "other@example.com", "another-password"); code != http.StatusUnauthorized {
			t.Errorf("second admin created: login got %d", code)
		}
	})

	t.Run("promotes an existing user", func(t *testing.T) {
		api := apptest.New(t)
		user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
		if resp := api.Put(userPath(user.UserID), api.Admin.Cookie, map[string]any{
			"email": user.Email, "fullName": "x", "role": auth.RoleUser, "isActive": false,
		}); resp.Code != http.StatusOK {
			t.Fatalf("deactivate user: got %d: %s", resp.Code, resp.Body)
		}
		deactivateAdmins(t, api)

		bootstrap(t, api, user.Email, "the-new-admin-password")
		admin := api.Login(user.Email, "the-new-admin-password")
		if admin.UserID != user.UserID || admin.TenantID != api.Distributor {
			t.Errorf("promoted user: id %s tenant %s", admin.UserID, admin.TenantID)
		}
		assertContains(t, api.Get("/api/auth/me", admin.Cookie).Body.String(), `"role":"admin"`)
		if n := countActiveAdmins(t, api); n != 1 {
			t.Errorf("%d active admins", n)
		}
	})

	t.Run("creates an admin when only inactive admins exist", func(t *testing.T) {
		api := apptest.New(t)
		deactivateAdmins(t, api)
		bootstrap(t, api, " New-Admin@Example.com ", "the-new-admin-password")
		admin := api.Login("new-admin@example.com", "the-new-admin-password")
		if admin.TenantID != api.Distributor || admin.UserID == uuid.Nil {
			t.Errorf("new admin in tenant %s", admin.TenantID)
		}
		if n := countActiveAdmins(t, api); n != 1 {
			t.Errorf("%d active admins", n)
		}
	})

	t.Run("warns without ADMIN_EMAIL", func(t *testing.T) {
		api := apptest.New(t)
		deactivateAdmins(t, api)
		bootstrap(t, api, "", "")
		if n := countActiveAdmins(t, api); n != 0 {
			t.Errorf("%d active admins", n)
		}
	})
}
