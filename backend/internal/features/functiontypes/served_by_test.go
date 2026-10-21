package functiontypes_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
)

func decodeAs[T any](t *testing.T, resp *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d: %s", resp.Code, status, resp.Body)
	}
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func newKind(t *testing.T, api *apptest.API, key string) capabilities.OutputKind {
	t.Helper()
	return decodeAs[capabilities.OutputKind](t, api.Post("/api/output-kinds", api.Admin.Cookie,
		map[string]any{"key": key, "name": map[string]string{"en": key}, "isActive": true}), http.StatusCreated)
}

func kind(t *testing.T, api *apptest.API, id uuid.UUID) capabilities.OutputKind {
	t.Helper()
	return decodeAs[capabilities.OutputKind](t, api.Get("/api/output-kinds/"+id.String(), api.Admin.Cookie), http.StatusOK)
}

// Served by, edited from the function side (D444).
func TestOutputKindIDs(t *testing.T) {
	api := apptest.New(t)
	relay, dim := newKind(t, api, "relay_output"), newKind(t, api, "dimmer_output")

	body := dimmer()
	body["outputKindIds"] = []any{dim.ID, relay.ID}
	ft := decodeAs[functiontypes.FunctionType](t, api.Post("/api/function-types", api.Admin.Cookie, body), http.StatusCreated)
	// In the kinds' order (relay was created first).
	if want := []uuid.UUID{relay.ID, dim.ID}; !reflect.DeepEqual(ft.OutputKindIDs, want) {
		t.Fatalf("created %v, want %v", ft.OutputKindIDs, want)
	}
	got := decodeAs[functiontypes.FunctionType](t, api.Get("/api/function-types/"+ft.ID.String(), api.Admin.Cookie), http.StatusOK)
	if len(got.OutputKindIDs) != 2 {
		t.Errorf("read %v", got.OutputKindIDs)
	}
	// The output kind side sees the link.
	if k := kind(t, api, relay.ID); !reflect.DeepEqual(k.FunctionTypeIDs, []uuid.UUID{ft.ID}) {
		t.Errorf("relay serves %v", k.FunctionTypeIDs)
	}

	// Left out keeps the links.
	got = decodeAs[functiontypes.FunctionType](t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie, dimmer()), http.StatusOK)
	if len(got.OutputKindIDs) != 2 {
		t.Errorf("kept %v", got.OutputKindIDs)
	}

	// Unknown and duplicate ids are field errors; nothing changes.
	body["outputKindIds"] = []any{relay.ID, ft.ID}
	resp := api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie, body)
	assertContains(t, resp.Body.String(), `{"location":"body.outputKindIds[1]","code":"output_kind.not_found"`)
	body["outputKindIds"] = []any{relay.ID, relay.ID}
	resp = api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie, body)
	assertContains(t, resp.Body.String(), `{"location":"body.outputKindIds[1]","code":"function_type.output_kind_duplicate"`)

	// A served function type cannot be deleted (function_type.in_use).
	resp = api.Delete("/api/function-types/"+ft.ID.String(), api.Admin.Cookie)
	if resp.Code != http.StatusConflict {
		t.Fatalf("delete served: got %d", resp.Code)
	}
	assertContains(t, resp.Body.String(), `"code":"function_type.in_use"`)

	// Replacing bumps updated_at of the kinds that gained or lost the
	// function (their editors are stale, D56); the unchanged one keeps it.
	relayBefore, dimBefore := kind(t, api, relay.ID), kind(t, api, dim.ID)
	time.Sleep(5 * time.Millisecond)
	body["outputKindIds"] = []any{relay.ID}
	got = decodeAs[functiontypes.FunctionType](t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie, body), http.StatusOK)
	if !reflect.DeepEqual(got.OutputKindIDs, []uuid.UUID{relay.ID}) {
		t.Errorf("replaced %v", got.OutputKindIDs)
	}
	if k := kind(t, api, dim.ID); !k.UpdatedAt.After(dimBefore.UpdatedAt) || len(k.FunctionTypeIDs) != 0 {
		t.Errorf("dimmer not bumped: %v -> %v, serves %v", dimBefore.UpdatedAt, k.UpdatedAt, k.FunctionTypeIDs)
	}
	if k := kind(t, api, relay.ID); !k.UpdatedAt.Equal(relayBefore.UpdatedAt) {
		t.Errorf("relay bumped without a change: %v -> %v", relayBefore.UpdatedAt, k.UpdatedAt)
	}
	// A stale output kind editor is refused.
	stale := map[string]any{"key": dim.Key, "name": map[string]string{"en": "x"}, "isActive": true, "expectedUpdatedAt": dimBefore.UpdatedAt}
	if resp := api.Put("/api/output-kinds/"+dim.ID.String(), api.Admin.Cookie, stale); resp.Code != http.StatusConflict {
		t.Errorf("stale kind update: got %d: %s", resp.Code, resp.Body)
	}

	// Empty clears; then the function type can be deleted.
	body["outputKindIds"] = []any{}
	got = decodeAs[functiontypes.FunctionType](t, api.Put("/api/function-types/"+ft.ID.String(), api.Admin.Cookie, body), http.StatusOK)
	if len(got.OutputKindIDs) != 0 {
		t.Errorf("cleared %v", got.OutputKindIDs)
	}
	if resp := api.Delete("/api/function-types/"+ft.ID.String(), api.Admin.Cookie); resp.Code != http.StatusNoContent {
		t.Errorf("delete unserved: got %d: %s", resp.Code, resp.Body)
	}
}
