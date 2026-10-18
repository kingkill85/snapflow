package functiontypes_test

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func newAPI(t *testing.T) humatest.TestAPI {
	t.Helper()
	apperr.Install()
	_, api := humatest.New(t)
	functiontypes.Register(api, functiontypes.NewService(store.New(testdb.Pool(t))))
	return api
}

func dimmer() map[string]any {
	return map[string]any{"key": "dimmer", "name": map[string]string{"en": "Dimmer", "de": "Dimmer"}}
}

func TestCreateAndList(t *testing.T) {
	api := newAPI(t)

	resp := api.Post("/api/function-types", dimmer())
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: got %d: %s", resp.Code, resp.Body)
	}

	resp = api.Get("/api/function-types")
	if resp.Code != http.StatusOK {
		t.Fatalf("list: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"key":"dimmer"`)
}

func TestDuplicateKeyIsConflict(t *testing.T) {
	api := newAPI(t)
	api.Post("/api/function-types", dimmer())

	resp := api.Post("/api/function-types", dimmer())
	if resp.Code != http.StatusConflict {
		t.Fatalf("got %d: %s", resp.Code, resp.Body)
	}
	assertContains(t, resp.Body.String(), `"code":"function_type.key_taken"`)
}

func TestValidation(t *testing.T) {
	api := newAPI(t)

	cases := map[string]struct {
		body map[string]any
		code string
	}{
		"bad key":         {map[string]any{"key": "Dimmer!", "name": map[string]string{"en": "Dimmer"}}, "function_type.key_format"},
		"no english name": {map[string]any{"key": "dimmer", "name": map[string]string{"de": "Dimmer"}}, "validation.required"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			resp := api.Post("/api/function-types", tc.body)
			if resp.Code != http.StatusUnprocessableEntity {
				t.Fatalf("got %d: %s", resp.Code, resp.Body)
			}
			assertContains(t, resp.Body.String(), tc.code)
		})
	}
}

func TestUpdateDeleteNotFound(t *testing.T) {
	api := newAPI(t)
	const missing = "/api/function-types/00000000-0000-0000-0000-000000000001"

	if resp := api.Get(missing); resp.Code != http.StatusNotFound {
		t.Fatalf("get: got %d", resp.Code)
	}
	if resp := api.Put(missing, dimmer()); resp.Code != http.StatusNotFound {
		t.Fatalf("update: got %d", resp.Code)
	}
	resp := api.Delete(missing)
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
