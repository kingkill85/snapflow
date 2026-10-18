package users_test

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func userInput(email string, role auth.Role, tenantID uuid.UUID) map[string]any {
	return map[string]any{
		"email": email, "fullName": "Anna Example", "role": role, "tenantId": tenantID,
		"isActive": true, "password": "a-long-password",
	}
}

func userPath(id uuid.UUID) string { return "/api/users/" + id.String() }

func TestAdminManagesUsers(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	partner := api.NewTenant("Acme")

	resp := api.Post("/api/users", admin, userInput("  Anna@Example.com ", auth.RoleTenantAdmin, partner))
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: got %d: %s", resp.Code, resp.Body)
	}
	body := resp.Body.String()
	assertContains(t, body, `"email":"anna@example.com"`, `"role":"tenant_admin"`, `"can":{"update":true,"delete":true}`)
	if strings.Contains(body, "password") {
		t.Fatalf("response leaks the password: %s", body)
	}
	id := uuid.MustParse(idOf(t, body))

	anna := api.Login("ANNA@example.com", "a-long-password")
	if anna.UserID != id {
		t.Fatal("login with different case must find the user")
	}

	update := userInput("anna@example.com", auth.RoleUser, partner)
	update["fullName"] = "Anna Changed"
	delete(update, "password")
	if resp := api.Put(userPath(id), admin, update); resp.Code != http.StatusOK {
		t.Fatalf("update: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, api.Get(userPath(id), admin).Body.String(), `"fullName":"Anna Changed"`, `"role":"user"`)

	list := api.Get("/api/users?tenantId="+partner.String(), admin).Body.String()
	assertContains(t, list, "anna@example.com")
	if strings.Contains(list, apptest.AdminEmail) {
		t.Errorf("tenant filter ignored: %s", list)
	}

	if resp := api.Delete(userPath(id), admin); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", anna.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("session of deleted user: got %d", resp.Code)
	}
}

func TestValidation(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	partner := api.NewTenant("Acme")
	api.Post("/api/users", admin, userInput("anna@example.com", auth.RoleUser, partner))

	short := userInput("bob@example.com", auth.RoleUser, partner)
	short["password"] = "short"
	noPassword := userInput("bob@example.com", auth.RoleUser, partner)
	delete(noPassword, "password")
	badRole := userInput("bob@example.com", "owner", partner)

	cases := map[string]struct {
		body   map[string]any
		status int
		code   string
	}{
		"duplicate email":  {userInput("ANNA@example.com", auth.RoleUser, partner), http.StatusConflict, "user.email_taken"},
		"short password":   {short, http.StatusUnprocessableEntity, "user.password_too_short"},
		"missing password": {noPassword, http.StatusUnprocessableEntity, "validation.required"},
		"unknown role":     {badRole, http.StatusUnprocessableEntity, "validation.failed"},
		"unknown tenant":   {userInput("bob@example.com", auth.RoleUser, uuid.New()), http.StatusUnprocessableEntity, "user.tenant_not_found"},
		"admin in partner": {userInput("bob@example.com", auth.RoleAdmin, partner), http.StatusUnprocessableEntity, "user.admin_requires_distributor"},
		"invalid email":    {userInput("not-an-email", auth.RoleUser, partner), http.StatusUnprocessableEntity, "validation.failed"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp := api.Post("/api/users", admin, tc.body)
			if resp.Code != tc.status {
				t.Fatalf("got %d: %s", resp.Code, resp.Body)
			}
			assertContains(t, resp.Body.String(), tc.code)
		})
	}
}

func TestPermissionMatrixForUsers(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)

	if resp := api.Get("/api/users"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d", resp.Code)
	}
	resp := api.Get("/api/users", user.Cookie)
	if resp.Code != http.StatusForbidden {
		t.Fatalf("user: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"permission":"users.manage"`)
}

func TestTenantAdminStaysInOwnTenant(t *testing.T) {
	api := apptest.New(t)
	acme, other := api.NewTenant("Acme"), api.NewTenant("Other")
	ta := api.NewUser(acme, auth.RoleTenantAdmin)
	colleague := api.NewUser(acme, auth.RoleUser)
	stranger := api.NewUser(other, auth.RoleUser)

	list := api.Get("/api/users?tenantId="+other.String(), ta.Cookie).Body.String()
	assertContains(t, list, colleague.Email, `"can":{"update":true,"delete":false}`)
	if strings.Contains(list, stranger.Email) || strings.Contains(list, apptest.AdminEmail) {
		t.Errorf("tenant admin sees other tenants: %s", list)
	}

	if resp := api.Get(userPath(stranger.UserID), ta.Cookie); resp.Code != http.StatusNotFound {
		t.Errorf("get other tenant's user: got %d", resp.Code)
	}
	if resp := api.Delete(userPath(stranger.UserID), ta.Cookie); resp.Code != http.StatusNotFound {
		t.Errorf("delete other tenant's user: got %d", resp.Code)
	}

	// Without a tenant the user lands in the caller's tenant.
	in := userInput("new@example.com", auth.RoleTenantAdmin, acme)
	delete(in, "tenantId")
	resp := api.Post("/api/users", ta.Cookie, in)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create in own tenant: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"tenantId":"`+acme.String()+`"`)

	resp = api.Post("/api/users", ta.Cookie, userInput("x@example.com", auth.RoleUser, other))
	if resp.Code != http.StatusForbidden {
		t.Fatalf("create in other tenant: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), "user.tenant_forbidden")

	moved := userInput(colleague.Email, auth.RoleUser, other)
	delete(moved, "password")
	if resp := api.Put(userPath(colleague.UserID), ta.Cookie, moved); resp.Code != http.StatusForbidden {
		t.Errorf("move user to other tenant: got %d", resp.Code)
	}
}

func TestNobodyGrantsAboveTheirRole(t *testing.T) {
	api := apptest.New(t)
	// A tenant admin of the distributor works next to the admins.
	ta := api.NewUser(api.Distributor, auth.RoleTenantAdmin)

	resp := api.Post("/api/users", ta.Cookie, userInput("boss@example.com", auth.RoleAdmin, api.Distributor))
	if resp.Code != http.StatusForbidden {
		t.Fatalf("create admin: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), "user.role_forbidden")

	list := api.Get("/api/users", ta.Cookie).Body.String()
	assertContains(t, list, `"email":"`+apptest.AdminEmail+`"`)
	assertContains(t, list, `"can":{"update":false,"delete":false}`)

	takeover := userInput(apptest.AdminEmail, auth.RoleUser, api.Distributor)
	resp = api.Put(userPath(api.Admin.UserID), ta.Cookie, takeover)
	if resp.Code != http.StatusForbidden {
		t.Fatalf("demote admin: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), "user.target_forbidden")
	if resp := api.Delete(userPath(api.Admin.UserID), ta.Cookie); resp.Code != http.StatusForbidden {
		t.Errorf("delete admin: got %d", resp.Code)
	}
}

func TestNobodyLocksThemselvesOut(t *testing.T) {
	api := apptest.New(t)
	self := userPath(api.Admin.UserID)
	in := func(role auth.Role, active bool) map[string]any {
		m := userInput(apptest.AdminEmail, role, api.Distributor)
		m["isActive"] = active
		delete(m, "password")
		return m
	}

	cases := map[string]struct {
		status int
		code   string
	}{
		"own role":         {api.Put(self, api.Admin.Cookie, in(auth.RoleUser, true)).Code, "user.own_role"},
		"own deactivation": {api.Put(self, api.Admin.Cookie, in(auth.RoleAdmin, false)).Code, "user.own_deactivation"},
		"own delete":       {api.Delete(self, api.Admin.Cookie).Code, "user.own_delete"},
	}
	for name, tc := range cases {
		if tc.status != http.StatusConflict {
			t.Errorf("%s: got %d", name, tc.status)
		}
	}
	if resp := api.Put(self, api.Admin.Cookie, in(auth.RoleAdmin, true)); resp.Code != http.StatusOK {
		t.Errorf("harmless self update: got %d: %s", resp.Code, resp.Body)
	}
}

func TestChangesApplyImmediately(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	user := api.NewUser(partner, auth.RoleUser)
	path := userPath(user.UserID)
	in := userInput(user.Email, auth.RoleTenantAdmin, partner)
	delete(in, "password")

	api.Put(path, api.Admin.Cookie, in)
	if resp := api.Get("/api/users", user.Cookie); resp.Code != http.StatusOK {
		t.Errorf("promoted user: got %d", resp.Code)
	}

	in["isActive"] = false
	api.Put(path, api.Admin.Cookie, in)
	if resp := api.Get("/api/auth/me", user.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("deactivated user: got %d", resp.Code)
	}
	resp := api.Post("/api/auth/login", map[string]any{"email": user.Email, "password": apptest.Password})
	if resp.Code != http.StatusForbidden {
		t.Errorf("deactivated login: got %d", resp.Code)
	}

	in["isActive"] = true
	in["password"] = "a-new-password"
	api.Put(path, api.Admin.Cookie, in)
	if resp := api.Get("/api/auth/me", user.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("password reset must end sessions: got %d", resp.Code)
	}
	api.Login(user.Email, "a-new-password")
}

func TestLogin(t *testing.T) {
	api := apptest.New(t)

	for name, body := range map[string]map[string]any{
		"wrong password": {"email": apptest.AdminEmail, "password": "wrong-password"},
		"unknown email":  {"email": "nobody@example.com", "password": "wrong-password"},
	} {
		resp := api.Post("/api/auth/login", body)
		if resp.Code != http.StatusUnauthorized || !strings.Contains(resp.Body.String(), "auth.invalid_credentials") {
			t.Errorf("%s: got %d: %s", name, resp.Code, resp.Body)
		}
	}

	resp := api.Post("/api/auth/login", map[string]any{"email": apptest.AdminEmail, "password": apptest.Password})
	cookie := resp.Header().Get("Set-Cookie")
	for _, attr := range []string{auth.CookieName + "=", "HttpOnly", "SameSite=Lax", "Path=/"} {
		if !strings.Contains(cookie, attr) {
			t.Errorf("cookie %q lacks %s", cookie, attr)
		}
	}
}

func TestLoginRateLimit(t *testing.T) {
	api := apptest.New(t)
	wrong := map[string]any{"email": apptest.AdminEmail, "password": "wrong-password"}
	for range 10 {
		api.Post("/api/auth/login", wrong)
	}
	resp := api.Post("/api/auth/login", map[string]any{"email": apptest.AdminEmail, "password": apptest.Password})
	if resp.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), "auth.too_many_attempts", `"seconds":`)
}

func TestMe(t *testing.T) {
	api := apptest.New(t)
	ta := api.NewUser(api.NewTenant("Acme"), auth.RoleTenantAdmin)

	resp := api.Get("/api/auth/me", ta.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(),
		`"tenantName":"Acme"`, `"role":"tenant_admin"`,
		`"permissions":["catalog.read","projects.read","projects.write","projects.delete","users.manage"]`,
		`"assignableRoles":["tenant_admin","user"]`)

	if resp := api.Get("/api/auth/me", "Authorization: Bearer "+ta.Token); resp.Code != http.StatusOK {
		t.Errorf("bearer token: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", "Authorization: Bearer nonsense"); resp.Code != http.StatusUnauthorized {
		t.Errorf("bad bearer token: got %d", resp.Code)
	}
}

func TestLogout(t *testing.T) {
	api := apptest.New(t)
	other := api.Login(apptest.AdminEmail, apptest.Password)

	resp := api.Post("/api/auth/logout", api.Admin.Cookie)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("logout: got %d", resp.Code)
	}
	assertContains(t, resp.Header().Get("Set-Cookie"), "Max-Age=0")
	if resp := api.Get("/api/auth/me", api.Admin.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("after logout: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", other.Cookie); resp.Code != http.StatusOK {
		t.Errorf("other session must survive: got %d", resp.Code)
	}
}

func TestCrossSiteWritesAreRefused(t *testing.T) {
	api := apptest.New(t)
	resp := api.Post("/api/auth/logout", api.Admin.Cookie, "Sec-Fetch-Site: cross-site")
	if resp.Code != http.StatusForbidden {
		t.Fatalf("cross-site: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", api.Admin.Cookie, "Sec-Fetch-Site: cross-site"); resp.Code != http.StatusOK {
		t.Errorf("cross-site read: got %d", resp.Code)
	}
	if resp := api.Post("/api/auth/logout", api.Admin.Cookie, "Sec-Fetch-Site: same-origin"); resp.Code != http.StatusNoContent {
		t.Errorf("same-origin: got %d", resp.Code)
	}
}

func TestProfile(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	user := api.NewUser(partner, auth.RoleUser)
	taken := api.NewUser(partner, auth.RoleUser)
	otherSession := api.Login(user.Email, apptest.Password)

	resp := api.Put("/api/auth/me", user.Cookie, map[string]any{"email": " New@Example.com", "fullName": "New Name"})
	if resp.Code != http.StatusOK {
		t.Fatalf("profile: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"email":"new@example.com"`, `"fullName":"New Name"`, `"tenantName":"Acme"`)

	resp = api.Put("/api/auth/me", user.Cookie, map[string]any{"email": taken.Email, "fullName": "x"})
	if resp.Code != http.StatusConflict {
		t.Errorf("taken email: got %d", resp.Code)
	}

	pw := func(current, next string) int {
		return api.Put("/api/auth/me/password", user.Cookie, map[string]any{"currentPassword": current, "newPassword": next}).Code
	}
	if code := pw("wrong-password", "another-password"); code != http.StatusUnprocessableEntity {
		t.Errorf("wrong current password: got %d", code)
	}
	if code := pw(apptest.Password, "short"); code != http.StatusUnprocessableEntity {
		t.Errorf("short new password: got %d", code)
	}
	if code := pw(apptest.Password, "another-password"); code != http.StatusNoContent {
		t.Fatalf("change password: got %d", code)
	}
	if resp := api.Get("/api/auth/me", user.Cookie); resp.Code != http.StatusOK {
		t.Errorf("current session must survive: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", otherSession.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("other sessions must end: got %d", resp.Code)
	}
	api.Login("new@example.com", "another-password")
}

func TestRoleMatrix(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)

	if resp := api.Get("/api/roles"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d", resp.Code)
	}
	resp := api.Get("/api/roles", user.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(),
		`{"role":"user","permissions":["catalog.read","projects.read","projects.write"]}`)
}

func TestHealthIsPublic(t *testing.T) {
	api := apptest.New(t)
	if resp := api.Get("/api/health"); resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
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
