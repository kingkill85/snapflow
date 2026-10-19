package users_test

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
	partner := api.NewTenant("Acme")
	self := userPath(api.Admin.UserID)
	in := func(role auth.Role, active bool, tenant uuid.UUID) map[string]any {
		m := userInput(apptest.AdminEmail, role, tenant)
		m["isActive"] = active
		delete(m, "password")
		return m
	}
	withPassword := in(auth.RoleAdmin, true, api.Distributor)
	withPassword["password"] = "a-new-password"

	cases := map[string]struct {
		resp *httptest.ResponseRecorder
		code string
	}{
		"own role":         {api.Put(self, api.Admin.Cookie, in(auth.RoleUser, true, api.Distributor)), "user.own_role"},
		"own deactivation": {api.Put(self, api.Admin.Cookie, in(auth.RoleAdmin, false, api.Distributor)), "user.own_deactivation"},
		"own tenant":       {api.Put(self, api.Admin.Cookie, in(auth.RoleAdmin, true, partner)), "user.own_tenant"},
		"own password":     {api.Put(self, api.Admin.Cookie, withPassword), "user.own_password"},
		"own delete":       {api.Delete(self, api.Admin.Cookie), "user.own_delete"},
	}
	for name, tc := range cases {
		if tc.resp.Code != http.StatusConflict {
			t.Errorf("%s: got %d", name, tc.resp.Code)
		}
		assertContains(t, tc.resp.Body.String(), `"code":"`+tc.code+`"`)
	}
	if resp := api.Put(self, api.Admin.Cookie, in(auth.RoleAdmin, true, api.Distributor)); resp.Code != http.StatusOK {
		t.Errorf("harmless self update: got %d: %s", resp.Code, resp.Body)
	}
	api.Login(apptest.AdminEmail, apptest.Password)
}

func TestUpdateValidation(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	ta := api.NewUser(partner, auth.RoleTenantAdmin)
	user := api.NewUser(partner, auth.RoleUser)
	other := api.NewUser(partner, auth.RoleUser)
	in := func(email string, role auth.Role, tenant uuid.UUID) map[string]any {
		m := userInput(email, role, tenant)
		delete(m, "password")
		return m
	}

	cases := map[string]struct {
		cookie string
		body   map[string]any
		status int
		code   string
	}{
		"role above own":   {ta.Cookie, in(user.Email, auth.RoleAdmin, partner), http.StatusForbidden, `"code":"user.role_forbidden"`},
		"admin in partner": {api.Admin.Cookie, in(user.Email, auth.RoleAdmin, partner), http.StatusUnprocessableEntity, `"code":"user.admin_requires_distributor"`},
		"unknown tenant":   {api.Admin.Cookie, in(user.Email, auth.RoleUser, uuid.New()), http.StatusUnprocessableEntity, `"code":"user.tenant_not_found"`},
		"email taken":      {api.Admin.Cookie, in(strings.ToUpper(other.Email), auth.RoleUser, partner), http.StatusConflict, `"code":"user.email_taken"`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp := api.Put(userPath(user.UserID), tc.cookie, tc.body)
			if resp.Code != tc.status {
				t.Fatalf("got %d: %s", resp.Code, resp.Body)
			}
			assertContains(t, resp.Body.String(), tc.code)
		})
	}

	resp := api.Put(userPath(uuid.New()), api.Admin.Cookie, in("x@example.com", auth.RoleUser, partner))
	if resp.Code != http.StatusNotFound {
		t.Errorf("update unknown user: got %d", resp.Code)
	}
	resp = api.Delete(userPath(uuid.New()), api.Admin.Cookie)
	if resp.Code != http.StatusNotFound {
		t.Errorf("delete unknown user: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"user.not_found"`)
}

func TestTenantAdminManagesPeers(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Acme")
	ta := api.NewUser(partner, auth.RoleTenantAdmin)
	peer := api.NewUser(partner, auth.RoleTenantAdmin)

	assertContains(t, api.Get(userPath(peer.UserID), ta.Cookie).Body.String(), `"can":{"update":true,"delete":true}`)
	in := userInput(peer.Email, auth.RoleUser, partner)
	in["password"] = "a-reset-password"
	if resp := api.Put(userPath(peer.UserID), ta.Cookie, in); resp.Code != http.StatusOK {
		t.Fatalf("update peer: got %d: %s", resp.Code, resp.Body)
	}
	api.Login(peer.Email, "a-reset-password")
	if resp := api.Delete(userPath(peer.UserID), ta.Cookie); resp.Code != http.StatusNoContent {
		t.Fatalf("delete peer: got %d: %s", resp.Code, resp.Body)
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
	assertContains(t, resp.Body.String(), `"code":"auth.account_disabled"`)
	// Only the right password reveals that the account is disabled.
	resp = api.Post("/api/auth/login", map[string]any{"email": user.Email, "password": "wrong-password"})
	if resp.Code != http.StatusUnauthorized {
		t.Errorf("deactivated login, wrong password: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"auth.invalid_credentials"`)

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

func TestMe(t *testing.T) {
	api := apptest.New(t)
	ta := api.NewUser(api.NewTenant("Acme"), auth.RoleTenantAdmin)

	resp := api.Get("/api/auth/me", ta.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(),
		`"tenantName":"Acme"`, `"role":"tenant_admin"`,
		`"permissions":["catalog.read","projects.read","projects.write","projects.delete","users.manage","tenants.profile"]`,
		`"assignableRoles":["tenant_admin","user"]`)

	user := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	assertContains(t, api.Get("/api/auth/me", user.Cookie).Body.String(), `"assignableRoles":[]`)

	if resp := api.Get("/api/auth/me", "Authorization: Bearer "+ta.Token); resp.Code != http.StatusOK {
		t.Errorf("bearer token: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", "Authorization: Bearer nonsense"); resp.Code != http.StatusUnauthorized {
		t.Errorf("bad bearer token: got %d", resp.Code)
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
