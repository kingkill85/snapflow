package tenants_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func tenant(name string, active bool) map[string]any {
	return map[string]any{"name": name, "isActive": active}
}

func TestCRUD(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie

	resp := api.Post("/api/tenants", admin, tenant("  Acme  ", true))
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"name":"Acme"`, `"isDistributor":false`, `"can":{"update":true,"delete":true}`)
	id := idOf(t, resp.Body.String())

	resp = api.Get("/api/tenants", admin)
	if resp.Code != http.StatusOK {
		t.Fatalf("list: got %d", resp.Code)
	}
	body := resp.Body.String()
	if strings.Index(body, `"Distributor"`) > strings.Index(body, `"Acme"`) {
		t.Errorf("distributor must come first: %s", body)
	}

	if resp := api.Put("/api/tenants/"+id, admin, tenant("Acme GmbH", false)); resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, api.Get("/api/tenants/"+id, admin).Body.String(), `"name":"Acme GmbH"`, `"isActive":false`)

	if resp := api.Delete("/api/tenants/"+id, admin); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d: %s", resp.Code, resp.Body)
	}
	if resp := api.Get("/api/tenants/"+id, admin); resp.Code != http.StatusNotFound {
		t.Fatalf("get deleted: got %d", resp.Code)
	}
}

func TestValidationAndConflicts(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	api.NewTenant("Acme")

	resp := api.Post("/api/tenants", admin, tenant("   ", true))
	if resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("blank name: got %d", resp.Code)
	}
	resp = api.Post("/api/tenants", admin, tenant("ACME", true))
	if resp.Code != http.StatusConflict {
		t.Fatalf("duplicate: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"code":"tenant.name_taken"`)

	other := idOf(t, api.Post("/api/tenants", admin, tenant("Other", true)).Body.String())
	resp = api.Put("/api/tenants/"+other, admin, tenant("aCmE", true))
	if resp.Code != http.StatusConflict {
		t.Fatalf("rename to taken name: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"code":"tenant.name_taken"`)
}

func TestUnknownTenant(t *testing.T) {
	api := apptest.New(t)
	path := "/api/tenants/" + uuid.NewString()
	for op, resp := range map[string]*httptest.ResponseRecorder{
		"get":    api.Get(path, api.Admin.Cookie),
		"update": api.Put(path, api.Admin.Cookie, tenant("Ghost", true)),
		"delete": api.Delete(path, api.Admin.Cookie),
	} {
		if resp.Code != http.StatusNotFound {
			t.Errorf("%s: got %d", op, resp.Code)
		}
		assertContains(t, resp.Body.String(), `"code":"tenant.not_found"`)
	}
}

func TestDistributorIsProtected(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	path := "/api/tenants/" + api.Distributor.String()

	assertContains(t, api.Get(path, admin).Body.String(), `"isDistributor":true`, `"can":{"update":true,"delete":false}`)
	codes := map[string]int{
		"deactivate": api.Put(path, admin, tenant("Distributor", false)).Code,
		"delete":     api.Delete(path, admin).Code,
	}
	for op, code := range codes {
		if code != http.StatusConflict {
			t.Errorf("%s: got %d", op, code)
		}
	}
	if resp := api.Put(path, admin, tenant("Smart Home Distribution", true)); resp.Code != http.StatusOK {
		t.Errorf("rename: got %d: %s", resp.Code, resp.Body)
	}
}

func TestOnlyAdminsManageTenants(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	path := "/api/tenants/" + partner.String()

	if resp := api.Get("/api/tenants"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d", resp.Code)
	}
	for _, role := range []auth.Role{auth.RoleTenantAdmin, auth.RoleUser} {
		s := api.NewUser(partner, role)
		codes := map[string]int{
			"list":   api.Get("/api/tenants", s.Cookie).Code,
			"get":    api.Get(path, s.Cookie).Code,
			"create": api.Post("/api/tenants", s.Cookie, tenant("Other", true)).Code,
			"update": api.Put(path, s.Cookie, tenant("Acme", false)).Code,
			"delete": api.Delete(path, s.Cookie).Code,
		}
		for op, code := range codes {
			if code != http.StatusForbidden {
				t.Errorf("%s %s: got %d", role, op, code)
			}
		}
	}
}

func TestDeactivationLocksUsersOut(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	user := api.NewUser(partner, auth.RoleUser)

	api.Put("/api/tenants/"+partner.String(), api.Admin.Cookie, tenant("Acme", false))

	if resp := api.Get("/api/auth/me", user.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("existing session: got %d", resp.Code)
	}
	resp := api.Post("/api/auth/login", map[string]any{"email": user.Email, "password": apptest.Password})
	if resp.Code != http.StatusForbidden {
		t.Fatalf("login: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"auth.account_disabled"`)
}

func TestDeleteRemovesUsers(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	user := api.NewUser(partner, auth.RoleUser)

	api.Delete("/api/tenants/"+partner.String(), api.Admin.Cookie)

	if resp := api.Get("/api/users/"+user.UserID.String(), api.Admin.Cookie); resp.Code != http.StatusNotFound {
		t.Errorf("user of deleted tenant: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", user.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("session of deleted user: got %d", resp.Code)
	}
}

func idOf(t *testing.T, body string) string {
	t.Helper()
	_, rest, ok := strings.Cut(body, `"id":"`)
	if !ok {
		t.Fatalf("no id in %s", body)
	}
	return rest[:36]
}

func assertContains(t *testing.T, body string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(body, w) {
			t.Errorf("response %s does not contain %s", body, w)
		}
	}
}

// D13: a tenant with projects is archived instead of deleted.
func TestArchive(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	if resp := api.Post("/api/product-types", admin, map[string]any{"key": "zigbee", "name": map[string]string{"en": "Zigbee"}, "isActive": true}); resp.Code != http.StatusCreated {
		t.Fatalf("type: %d %s", resp.Code, resp.Body)
	}
	acme := api.NewTenant("Acme")
	empty := api.NewTenant("Empty")
	user := api.NewUser(acme, auth.RoleUser)
	if resp := api.Post("/api/projects", user.Cookie, map[string]any{"name": "Villa"}); resp.Code != http.StatusCreated {
		t.Fatalf("project: %d %s", resp.Code, resp.Body)
	}
	assertContains(t, api.Get("/api/tenants/"+acme.String(), admin).Body.String(), `"projectCount":1`)
	assertContains(t, api.Get("/api/tenants/"+empty.String(), admin).Body.String(), `"projectCount":0`)

	// Without projects: deleted.
	if resp := api.Delete("/api/tenants/"+empty.String(), admin); resp.Code != http.StatusNoContent {
		t.Fatalf("delete empty: %d %s", resp.Code, resp.Body)
	}
	if resp := api.Get("/api/tenants/"+empty.String(), admin); resp.Code != http.StatusNotFound {
		t.Fatalf("empty tenant still there: %d", resp.Code)
	}

	// With projects: archived and deactivated, users and projects kept.
	if resp := api.Delete("/api/tenants/"+acme.String(), admin); resp.Code != http.StatusNoContent {
		t.Fatalf("archive: %d %s", resp.Code, resp.Body)
	}
	body := api.Get("/api/tenants/"+acme.String(), admin).Body.String()
	assertContains(t, body, `"archivedAt":"`, `"isActive":false`, `"projectCount":1`)
	if strings.Contains(api.Get("/api/tenants", admin).Body.String(), `"Acme"`) {
		t.Error("archived tenant listed without includeArchived")
	}
	assertContains(t, api.Get("/api/tenants?includeArchived=true", admin).Body.String(), `"Acme"`)
	if resp := api.Get("/api/users?tenantId="+acme.String(), admin); !strings.Contains(resp.Body.String(), user.Email) {
		t.Errorf("users kept: %s", resp.Body)
	}

	// Archived: not assignable, not activatable, not deletable again.
	resp := api.Post("/api/users", admin, map[string]any{
		"email": "new@snapflow.test", "fullName": "New", "role": "user", "tenantId": acme, "isActive": true, "password": apptest.Password,
	})
	if resp.Code != http.StatusUnprocessableEntity || !strings.Contains(resp.Body.String(), "user.tenant_not_found") {
		t.Errorf("user in archived tenant: %d %s", resp.Code, resp.Body)
	}
	resp = api.Post("/api/projects", admin, map[string]any{"name": "x", "tenantId": acme})
	if resp.Code != http.StatusUnprocessableEntity || !strings.Contains(resp.Body.String(), "project.tenant_not_found") {
		t.Errorf("project in archived tenant: %d %s", resp.Code, resp.Body)
	}
	resp = api.Put("/api/tenants/"+acme.String(), admin, tenant("Acme", true))
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "tenant.archived") {
		t.Errorf("activate archived: %d %s", resp.Code, resp.Body)
	}
	resp = api.Delete("/api/tenants/"+acme.String(), admin)
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), "tenant.has_projects") {
		t.Errorf("delete archived: %d %s", resp.Code, resp.Body)
	}

	// Restore: unarchived, still inactive until activated.
	resp = api.Post("/api/tenants/"+acme.String()+"/restore", admin, map[string]any{})
	if resp.Code != http.StatusOK || strings.Contains(resp.Body.String(), "archivedAt") || !strings.Contains(resp.Body.String(), `"isActive":false`) {
		t.Fatalf("restore: %d %s", resp.Code, resp.Body)
	}
	if resp := api.Put("/api/tenants/"+acme.String(), admin, tenant("Acme", true)); resp.Code != http.StatusOK {
		t.Errorf("activate restored: %d %s", resp.Code, resp.Body)
	}
	if resp := api.Post("/api/tenants/"+acme.String()+"/restore", admin, map[string]any{}); resp.Code != http.StatusOK {
		t.Errorf("restore again: %d", resp.Code)
	}
	if resp := api.Post("/api/tenants/"+uuid.NewString()+"/restore", admin, map[string]any{}); resp.Code != http.StatusNotFound {
		t.Errorf("restore unknown: %d", resp.Code)
	}
}

// archiveBeforeUpdate archives the tenant right before the update, as a
// concurrent delete would between the service's read and its write.
type archiveBeforeUpdate struct{ store.Querier }

func (a archiveBeforeUpdate) UpdateTenant(ctx context.Context, arg store.UpdateTenantParams) (store.Tenant, error) {
	if _, err := a.ArchiveTenant(ctx, arg.ID); err != nil {
		return store.Tenant{}, err
	}
	return a.Querier.UpdateTenant(ctx, arg)
}

// An update cannot activate a tenant archived after it was read.
func TestActivateArchivedConcurrently(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	svc := tenants.NewService(archiveBeforeUpdate{store.New(api.DB)})
	ctx := auth.WithActor(t.Context(), auth.Actor{UserID: api.Admin.UserID, TenantID: api.Distributor, Role: auth.RoleAdmin})
	_, err := svc.Update(ctx, acme, tenants.TenantInput{Name: "Acme", IsActive: true})
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != "tenant.archived" {
		t.Fatalf("want tenant.archived, got %v", err)
	}
	var active bool
	if err := api.DB.QueryRow(ctx, "SELECT is_active FROM tenants WHERE id = $1", acme).Scan(&active); err != nil || active {
		t.Errorf("archived tenant activated: %v %v", active, err)
	}
	// Deactivating (or renaming) an archived tenant is still fine.
	if _, err := svc.Update(ctx, acme, tenants.TenantInput{Name: "Acme 2", IsActive: false}); err != nil {
		t.Errorf("rename archived: %v", err)
	}
}
