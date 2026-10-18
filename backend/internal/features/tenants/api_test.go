package tenants_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
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
