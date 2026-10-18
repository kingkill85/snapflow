package functiontypes_test

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func dimmer() map[string]any {
	return map[string]any{"key": "dimmer", "name": map[string]string{"en": "Dimmer", "de": "Dimmer"}}
}

func TestCreateAndList(t *testing.T) {
	api := apptest.New(t)

	resp := api.Post("/api/function-types", api.Admin.Cookie, dimmer())
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: got %d: %s", resp.Code, resp.Body)
	}

	resp = api.Get("/api/function-types", api.Admin.Cookie)
	if resp.Code != http.StatusOK {
		t.Fatalf("list: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"key":"dimmer"`)
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	user := api.NewUser(api.NewTenant("Partner"), auth.RoleUser)

	if resp := api.Get("/api/function-types"); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous read: got %d", resp.Code)
	}
	if resp := api.Get("/api/function-types", user.Cookie); resp.Code != http.StatusOK {
		t.Errorf("user read: got %d", resp.Code)
	}
	resp := api.Post("/api/function-types", user.Cookie, dimmer())
	if resp.Code != http.StatusForbidden {
		t.Fatalf("user write: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"permission":"catalog.write"`)
}

func TestDuplicateKeyIsConflict(t *testing.T) {
	api := apptest.New(t)
	api.Post("/api/function-types", api.Admin.Cookie, dimmer())

	resp := api.Post("/api/function-types", api.Admin.Cookie, dimmer())
	if resp.Code != http.StatusConflict {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"code":"function_type.key_taken"`)
}

func TestValidation(t *testing.T) {
	api := apptest.New(t)

	cases := map[string]struct {
		body map[string]any
		code string
	}{
		"bad key":         {map[string]any{"key": "Dimmer!", "name": map[string]string{"en": "Dimmer"}}, "function_type.key_format"},
		"no english name": {map[string]any{"key": "dimmer", "name": map[string]string{"de": "Dimmer"}}, "validation.required"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp := api.Post("/api/function-types", api.Admin.Cookie, tc.body)
			if resp.Code != http.StatusUnprocessableEntity {
				t.Fatalf("got %d: %s", resp.Code, resp.Body)
			}
			assertContains(t, resp.Body.String(), tc.code)
		})
	}
}

func TestUpdateDeleteNotFound(t *testing.T) {
	api := apptest.New(t)
	const missing = "/api/function-types/00000000-0000-0000-0000-000000000001"

	if resp := api.Get(missing, api.Admin.Cookie); resp.Code != http.StatusNotFound {
		t.Fatalf("get: got %d", resp.Code)
	}
	if resp := api.Put(missing, api.Admin.Cookie, dimmer()); resp.Code != http.StatusNotFound {
		t.Fatalf("update: got %d", resp.Code)
	}
	resp := api.Delete(missing, api.Admin.Cookie)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("delete: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"function_type.not_found"`)
}

func assertContains(t *testing.T, body, want string) {
	t.Helper()
	if !strings.Contains(body, want) {
		t.Fatalf("response %s does not contain %s", body, want)
	}
}

func TestUnknownLocale(t *testing.T) {
	api := apptest.New(t)
	b := map[string]any{"key": "dimmer", "name": map[string]string{"en": "Dimmer", "fr": "Variateur"}}
	resp := api.Post("/api/function-types", api.Admin.Cookie, b)
	if resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `{"location":"body.name.fr","code":"validation.locale"`)
}
