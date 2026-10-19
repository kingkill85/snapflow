package roomtemplates_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/roomtemplates"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func wantCode(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("want %d %s, got %d: %s", status, code, resp.Code, resp.Body)
	}
	if code != "" && !strings.Contains(resp.Body.String(), `"`+code+`"`) {
		t.Fatalf("want code %s: %s", code, resp.Body)
	}
}

func fields(t *testing.T, resp *httptest.ResponseRecorder) []string {
	t.Helper()
	wantCode(t, resp, http.StatusUnprocessableEntity, "")
	var p struct {
		Fields []struct{ Location, Code string } `json:"fields"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range p.Fields {
		out = append(out, f.Location+" "+f.Code)
	}
	return out
}

func text(en string) map[string]string { return map[string]string{"en": en} }

func line(functionType string) map[string]any {
	return map[string]any{"functionTypeId": functionType, "quantity": 2, "powerW": 40.5, "loadTypeId": nil, "label": "Ceiling"}
}

func TestRoomTemplates(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	resp := api.Post("/api/load-types", admin, map[string]any{"key": "rt_motor", "name": text("Motor"), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	motor := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/load-types", admin, map[string]any{"key": "rt_led", "name": text("LED"), "isActive": true})
	wantCode(t, resp, http.StatusCreated, "")
	led := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/function-types", admin, map[string]any{"key": "rt_blind", "name": text("Blind"), "loadTypeIds": []string{motor}})
	wantCode(t, resp, http.StatusCreated, "")
	blind := decode[struct{ ID string }](t, resp).ID
	resp = api.Post("/api/function-types", admin, map[string]any{"key": "rt_old", "name": text("Old"), "isActive": false})
	wantCode(t, resp, http.StatusCreated, "")
	old := decode[struct{ ID string }](t, resp).ID

	// Validation.
	badLoad := line(blind)
	badLoad["loadTypeId"] = led
	badQty := line(blind)
	badQty["quantity"], badQty["powerW"] = 0, 200000
	got := fields(t, api.Post("/api/room-templates", admin, map[string]any{
		"key": "Bad Key", "name": map[string]string{"de": "x"}, "equipmentLevel": map[string]string{"de": "Komfort"}, "isActive": true,
		"lines": []any{badLoad, badQty, line(uuid.NewString()), line(old)},
	}))
	for _, w := range []string{
		"body.key room_template.key_format", "body.name.en validation.required", "body.equipmentLevel.en validation.required",
		"body.lines[0].loadTypeId need.load_type_not_allowed", "body.lines[1].quantity validation.range", "body.lines[1].powerW validation.range",
		"body.lines[2].functionTypeId function_type.not_found", "body.lines[3].functionTypeId need.function_type_inactive",
	} {
		if !slices.Contains(got, w) {
			t.Errorf("missing %q in %v", w, got)
		}
	}

	// CRUD.
	withMotor := line(blind)
	withMotor["loadTypeId"] = motor
	resp = api.Post("/api/room-templates", admin, map[string]any{
		"key": "living", "name": text(" Living room "), "equipmentLevel": text("Comfort"), "isActive": true, "lines": []any{withMotor},
	})
	wantCode(t, resp, http.StatusCreated, "")
	living := decode[roomtemplates.RoomTemplate](t, resp)
	if living.Name["en"] != "Living room" || living.EquipmentLevel["en"] != "Comfort" || len(living.Lines) != 1 ||
		living.Lines[0].PowerW == nil || *living.Lines[0].PowerW != 40.5 || !living.Can.Update {
		t.Errorf("created: %+v", living)
	}
	wantCode(t, api.Post("/api/room-templates", admin, map[string]any{"key": "living", "name": text("x"), "isActive": true, "lines": []any{}}),
		http.StatusConflict, "room_template.key_taken")
	resp = api.Post("/api/room-templates", admin, map[string]any{"key": "bath", "name": text("Bath"), "isActive": false, "lines": []any{}})
	wantCode(t, resp, http.StatusCreated, "")
	bath := decode[roomtemplates.RoomTemplate](t, resp)
	if len(bath.EquipmentLevel) != 0 || bath.Lines == nil {
		t.Errorf("bath: %+v", bath)
	}

	resp = api.Put("/api/room-templates/"+living.ID.String(), admin, map[string]any{
		"key": "living", "name": text("Living"), "isActive": true, "lines": []any{line(blind), line(blind)},
		"expectedUpdatedAt": living.UpdatedAt,
	})
	wantCode(t, resp, http.StatusOK, "")
	updated := decode[roomtemplates.RoomTemplate](t, resp)
	if len(updated.Lines) != 2 || len(updated.EquipmentLevel) != 0 {
		t.Errorf("updated: %+v", updated)
	}
	wantCode(t, api.Put("/api/room-templates/"+living.ID.String(), admin, map[string]any{
		"key": "living", "name": text("Living"), "isActive": true, "lines": []any{}, "expectedUpdatedAt": living.UpdatedAt,
	}), http.StatusConflict, "room_template.stale")

	// Lists: active only by default; order.
	list := decode[roomtemplates.RoomTemplateList](t, api.Get("/api/room-templates", admin))
	if len(list.Items) != 1 {
		t.Errorf("active list: %+v", list.Items)
	}
	resp = api.Put("/api/room-templates/order", admin, map[string]any{"ids": []uuid.UUID{bath.ID, living.ID}})
	wantCode(t, resp, http.StatusOK, "")
	if l := decode[roomtemplates.RoomTemplateList](t, resp); len(l.Items) != 2 || l.Items[0].ID != bath.ID {
		t.Errorf("order: %+v", l.Items)
	}
	wantCode(t, api.Put("/api/room-templates/order", admin, map[string]any{"ids": []uuid.UUID{bath.ID}}),
		http.StatusUnprocessableEntity, "room_template.order_mismatch")

	// Function types and load types used by templates cannot be deleted.
	wantCode(t, api.Delete("/api/function-types/"+blind, admin), http.StatusConflict, "function_type.in_use")

	// Permissions: users read, only catalog.write changes.
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	resp = api.Get("/api/room-templates/"+living.ID.String(), user.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	if decode[roomtemplates.RoomTemplate](t, resp).Can.Update {
		t.Error("user can update")
	}
	wantCode(t, api.Post("/api/room-templates", user.Cookie, map[string]any{"key": "x", "name": text("x"), "isActive": true, "lines": []any{}}),
		http.StatusForbidden, "auth.forbidden")
	wantCode(t, api.Delete("/api/room-templates/"+living.ID.String(), user.Cookie), http.StatusForbidden, "auth.forbidden")

	// Delete.
	wantCode(t, api.Delete("/api/room-templates/"+living.ID.String(), admin), http.StatusNoContent, "")
	wantCode(t, api.Get("/api/room-templates/"+living.ID.String(), admin), http.StatusNotFound, "room_template.not_found")
	wantCode(t, api.Delete("/api/function-types/"+blind, admin), http.StatusNoContent, "")
}
