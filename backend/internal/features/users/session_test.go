package users_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

func login(api *apptest.API, email, password string, headers ...any) int {
	args := append([]any{map[string]any{"email": email, "password": password}}, headers...)
	return api.Post("/api/auth/login", args...).Code
}

func from(ip string) string { return "X-Forwarded-For: " + ip }

func TestLoginLimitsFailedAttempts(t *testing.T) {
	api := apptest.New(t)
	attacker, owner := from("203.0.113.1"), from("198.51.100.1")
	for i := range 10 {
		if code := login(api, apptest.AdminEmail, "wrong-password", attacker); code != http.StatusUnauthorized {
			t.Fatalf("failure %d: got %d", i+1, code)
		}
	}
	resp := api.Post("/api/auth/login", map[string]any{"email": apptest.AdminEmail, "password": apptest.Password}, attacker)
	if resp.Code != http.StatusTooManyRequests {
		t.Fatalf("after 10 failures: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"auth.too_many_attempts"`, `"seconds":`)
	if ra := resp.Header().Get("Retry-After"); ra == "" || ra == "0" {
		t.Errorf("Retry-After: %q", ra)
	}
	// The stranger does not lock the owner out.
	if code := login(api, apptest.AdminEmail, apptest.Password, owner); code != http.StatusOK {
		t.Errorf("owner from another address: got %d", code)
	}
}

func TestLoginLimitIgnoresSuccessAndCase(t *testing.T) {
	api := apptest.New(t)
	for range 12 {
		if code := login(api, apptest.AdminEmail, apptest.Password); code != http.StatusOK {
			t.Fatalf("successful logins must not count: got %d", code)
		}
	}
	upper := strings.ToUpper(apptest.AdminEmail)
	for i := range 9 {
		login(api, []string{apptest.AdminEmail, upper}[i%2], "wrong-password")
	}
	if code := login(api, " "+upper, apptest.Password); code != http.StatusOK {
		t.Fatalf("login after 9 failures: got %d", code)
	}
	// The success cleared the bucket: nine more failures are allowed.
	for i := range 9 {
		if code := login(api, upper, "wrong-password"); code != http.StatusUnauthorized {
			t.Fatalf("failure %d after reset: got %d", i+1, code)
		}
	}
	login(api, apptest.AdminEmail, "wrong-password")
	// Case variants share one bucket.
	if code := login(api, upper, apptest.Password); code != http.StatusTooManyRequests {
		t.Fatalf("after 10 mixed-case failures: got %d", code)
	}
}

func TestLoginCapsPerEmailAndPerAddress(t *testing.T) {
	api := apptest.New(t)
	// Spread over many addresses, the email is still capped.
	for i := range 50 {
		login(api, apptest.AdminEmail, "wrong-password", from(fmt.Sprintf("203.0.113.%d", i+1)))
	}
	if code := login(api, apptest.AdminEmail, apptest.Password, from("198.51.100.1")); code != http.StatusTooManyRequests {
		t.Errorf("after 50 failures for one email: got %d", code)
	}

	// Spread over many emails, the address is still capped.
	sprayer := from("198.51.100.2")
	for i := range 100 {
		login(api, fmt.Sprintf("nobody-%d@example.com", i), "wrong-password", sprayer)
	}
	user := api.NewUser(api.Distributor, auth.RoleUser)
	if code := login(api, user.Email, apptest.Password, sprayer); code != http.StatusTooManyRequests {
		t.Errorf("after 100 failures from one address: got %d", code)
	}
	if code := login(api, user.Email, apptest.Password, from("198.51.100.3")); code != http.StatusOK {
		t.Errorf("other address: got %d", code)
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

func TestLogoutAll(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	second := api.Login(user.Email, apptest.Password)

	resp := api.Post("/api/auth/logout-all", user.Cookie)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("logout-all: got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Header().Get("Set-Cookie"), "Max-Age=0")
	for name, cookie := range map[string]string{"current": user.Cookie, "other": second.Cookie} {
		if resp := api.Get("/api/auth/me", cookie); resp.Code != http.StatusUnauthorized {
			t.Errorf("%s session: got %d", name, resp.Code)
		}
	}
	if resp := api.Get("/api/auth/me", api.Admin.Cookie); resp.Code != http.StatusOK {
		t.Errorf("other users' sessions must survive: got %d", resp.Code)
	}
	if resp := api.Post("/api/auth/logout-all"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: got %d", resp.Code)
	}
}

func TestCrossSiteWritesAreRefused(t *testing.T) {
	api := apptest.New(t)
	bearer := "Authorization: Bearer " + api.Admin.Token
	refused := map[string]int{
		"cookie": api.Post("/api/auth/logout", api.Admin.Cookie, "Sec-Fetch-Site: cross-site").Code,
		"bearer": api.Post("/api/auth/logout", bearer, "Sec-Fetch-Site: same-site").Code,
		"login": api.Post("/api/auth/login", map[string]any{"email": apptest.AdminEmail, "password": apptest.Password},
			"Sec-Fetch-Site: cross-site").Code,
	}
	for name, code := range refused {
		if code != http.StatusForbidden {
			t.Errorf("cross-site %s write: got %d", name, code)
		}
	}
	for name, header := range map[string]string{"cookie": api.Admin.Cookie, "bearer": bearer} {
		if resp := api.Get("/api/auth/me", header, "Sec-Fetch-Site: cross-site"); resp.Code != http.StatusOK {
			t.Errorf("cross-site %s read: got %d", name, resp.Code)
		}
	}
	if code := login(api, apptest.AdminEmail, apptest.Password, "Sec-Fetch-Site: same-origin"); code != http.StatusOK {
		t.Errorf("same-origin login: got %d", code)
	}
	if resp := api.Post("/api/auth/logout", api.Admin.Cookie, "Sec-Fetch-Site: same-origin"); resp.Code != http.StatusNoContent {
		t.Errorf("same-origin: got %d", resp.Code)
	}
}

func TestSessionExpiry(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	if _, err := api.DB.Exec(context.Background(),
		`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, user.UserID); err != nil {
		t.Fatal(err)
	}
	resp := api.Get("/api/auth/me", user.Cookie)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expired session: got %d", resp.Code)
	}
	assertContains(t, resp.Header().Get("Set-Cookie"), auth.CookieName+"=;", "Max-Age=0")
}

func TestSessionRenewal(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)

	if resp := api.Get("/api/auth/me", user.Cookie); resp.Header().Get("Set-Cookie") != "" {
		t.Errorf("fresh session renewed: %s", resp.Header().Get("Set-Cookie"))
	}
	if _, err := api.DB.Exec(context.Background(),
		`UPDATE sessions SET last_used_at = now() - interval '61 minutes' WHERE user_id = $1`, user.UserID); err != nil {
		t.Fatal(err)
	}
	resp := api.Get("/api/auth/me", user.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Header().Get("Set-Cookie"), auth.CookieName+"="+user.Token, "Max-Age=1209600")
	if resp := api.Get("/api/auth/me", user.Cookie); resp.Header().Get("Set-Cookie") != "" {
		t.Errorf("renewed twice within an hour")
	}
}

func TestInvalidCookieIsClearedOnPublicEndpoints(t *testing.T) {
	api := apptest.New(t)
	resp := api.Get("/api/health", "Cookie: "+auth.CookieName+"=nonsense")
	if resp.Code != http.StatusOK {
		t.Fatalf("got %d", resp.Code)
	}
	assertContains(t, resp.Header().Get("Set-Cookie"), "Max-Age=0")
}

func TestChangePasswordOverBearer(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	other := api.Login(user.Email, apptest.Password)
	bearer := "Authorization: Bearer " + user.Token

	resp := api.Put("/api/auth/me/password", bearer, map[string]any{"currentPassword": apptest.Password, "newPassword": "another-password"})
	if resp.Code != http.StatusNoContent {
		t.Fatalf("change password: got %d: %s", resp.Code, resp.Body)
	}
	if resp := api.Get("/api/auth/me", bearer); resp.Code != http.StatusOK {
		t.Errorf("bearer session must survive: got %d", resp.Code)
	}
	if resp := api.Get("/api/auth/me", other.Cookie); resp.Code != http.StatusUnauthorized {
		t.Errorf("other session must end: got %d", resp.Code)
	}
}

func TestChangePasswordLimitsWrongPasswords(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	change := func(current string) *httptest.ResponseRecorder {
		return api.Put("/api/auth/me/password", user.Cookie, map[string]any{"currentPassword": current, "newPassword": "another-password"})
	}
	for i := range 10 {
		if resp := change("wrong-password"); resp.Code != http.StatusUnprocessableEntity {
			t.Fatalf("wrong password %d: got %d", i+1, resp.Code)
		}
	}
	resp := change(apptest.Password)
	if resp.Code != http.StatusTooManyRequests {
		t.Fatalf("after 10 wrong passwords: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"auth.too_many_attempts"`, `"seconds":`)
	if resp.Header().Get("Retry-After") == "" {
		t.Error("no Retry-After header")
	}
}
