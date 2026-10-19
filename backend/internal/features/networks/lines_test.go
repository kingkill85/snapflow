package networks_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
)

// saveBoard replaces a board's modules (row 0, 4 TE apart).
func (w world) saveBoard(t *testing.T, id uuid.UUID, modules ...[2]uuid.UUID) {
	t.Helper()
	b := decode[plans.BoardContent](t, w.api.Get("/api/plans/"+id.String()+"/board", w.user.Cookie))
	list := []any{}
	for i, m := range modules {
		list = append(list, map[string]any{"id": m[0], "rowId": b.Rows[0].ID, "offsetTe": float64(i * 4), "variantId": m[1], "label": "",
			"existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}})
	}
	want(t, w.api.Put("/api/plans/"+id.String()+"/board", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil, "rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 24}},
		"modules": list}), http.StatusOK, "")
}

func (w world) lines(t *testing.T, cookie string) []networks.BusLine {
	t.Helper()
	return decode[[]networks.BusLine](t, w.api.Get("/api/versions/"+w.version.String()+"/bus-lines", cookie))
}

// D372: the default line comes with a content save, GET never writes.
func TestDefaultLineOnSave(t *testing.T) {
	w := setup(t)
	api, v := w.api, w.version.String()
	act := uuid.New()

	// A board without bus modules creates nothing.
	board := w.board(t, "Board")
	if l := w.lines(t, w.user.Cookie); len(l) != 0 {
		t.Fatalf("lines without members: %+v", l)
	}
	// Saving a bus module creates "KNX 1".
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator})
	l := w.lines(t, w.user.Cookie)
	if len(l) != 1 || l[0].Name != "KNX 1" || l[0].ProductTypeID != w.c.KNX {
		t.Fatalf("default line: %+v", l)
	}
	// Without a line (deleted: no member pinned), members are unassigned,
	// and GET creates nothing (every role writes; read-only projects below).
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+l[0].ID.String(), w.user.Cookie), http.StatusNoContent, "")
	for _, cookie := range []string{w.user.Cookie, api.Admin.Cookie} {
		n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
		if len(n.BusSystems) != 1 || len(n.BusSystems[0].Lines) != 0 || len(n.BusSystems[0].Unassigned) != 1 {
			t.Errorf("no line: %+v", n.BusSystems)
		}
		if len(w.lines(t, cookie)) != 0 {
			t.Errorf("GET created a line")
		}
	}
	// The next save brings it back.
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator})
	if l := w.lines(t, w.user.Cookie); len(l) != 1 || l[0].Name != "KNX 1" {
		t.Fatalf("default line again: %+v", l)
	}
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+w.lines(t, w.user.Cookie)[0].ID.String(), w.user.Cookie), http.StatusNoContent, "")

	// A completed project: GET still writes nothing, can.update false.
	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), w.user.Cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), w.user.Cookie, map[string]any{
		"name": p.Name, "status": "completed", "expectedUpdatedAt": p.UpdatedAt}), http.StatusOK, "")
	n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", w.user.Cookie))
	if n.Can.Update || len(n.BusSystems[0].Lines) != 0 || len(n.BusSystems[0].Unassigned) != 1 || len(w.lines(t, w.user.Cookie)) != 0 {
		t.Errorf("read-only: %+v", n)
	}
}

// D373: a line is in use only by pins of current members; clearing works
// for removed items; a system with lines but no members keeps its name.
func TestLineInUseAndEmptySystems(t *testing.T) {
	w := setup(t)
	api, cookie, v := w.api, w.user.Cookie, w.version.String()
	act := uuid.New()
	board := w.board(t, "Board", [2]uuid.UUID{act, w.c.Actuator})
	resp := api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "Line 2", "devicesMax": 32})
	want(t, resp, http.StatusCreated, "")
	line2 := decode[networks.BusLine](t, resp)
	if line2.DevicesMax == nil || *line2.DevicesMax != 32 {
		t.Errorf("devicesMax: %+v", line2)
	}
	want(t, api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "L3", "devicesMax": 0}),
		http.StatusUnprocessableEntity, "")
	want(t, api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": act, "busLineId": line2.ID}}}), http.StatusOK, "")
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie), http.StatusConflict, "bus_line.in_use")

	// The module goes: the pin dangles and no longer counts.
	w.saveBoard(t, board)
	n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
	if len(n.BusSystems) != 1 || n.BusSystems[0].ProductType.Key != "knx" || n.BusSystems[0].ProductType.Abbreviation != "KNX" ||
		n.BusSystems[0].ProductType.Name["en"] != "KNX" || len(n.BusSystems[0].Lines) != 2 {
		t.Errorf("system without members: %+v", n.BusSystems)
	}
	// Clearing the dangling assignment works although the item is gone.
	want(t, api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": act}}}), http.StatusOK, "")
	want(t, api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": act, "busLineId": line2.ID}}}), http.StatusUnprocessableEntity, "")
	// Pin again via the module, remove it, delete the line: allowed.
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator})
	want(t, api.Put("/api/versions/"+v+"/network-assignments", cookie, map[string]any{"assignments": []any{
		map[string]any{"planId": board, "itemId": act, "busLineId": line2.ID}}}), http.StatusOK, "")
	w.saveBoard(t, board)
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie), http.StatusNoContent, "")
}

// D377: a line needs an active bus type of the project; a type used by a
// line cannot be deleted.
func TestCreateLineProductType(t *testing.T) {
	w := setup(t)
	api, cookie, v := w.api, w.user.Cookie, w.version.String()
	admin := api.Admin.Cookie
	resp := api.Post("/api/product-types", admin, map[string]any{"key": "hdl", "name": map[string]string{"en": "HDL"}, "abbreviation": "HDL",
		"isActive": true, "topology": "bus"})
	want(t, resp, http.StatusCreated, "")
	hdl := decode[struct{ ID uuid.UUID }](t, resp).ID
	want(t, api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": hdl, "name": "H"}),
		http.StatusUnprocessableEntity, "")
	if !contains(api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": hdl, "name": "H"}).Body.String(), "bus_line.product_type_not_in_project") {
		t.Error("want product_type_not_in_project")
	}

	// In the project: allowed; the type cannot be deleted then.
	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	resp = api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{"name": p.Name, "status": "active", "expectedUpdatedAt": p.UpdatedAt,
		"productTypeIds": []any{w.c.KNX, w.c.Zigbee, hdl}})
	want(t, resp, http.StatusOK, "")
	want(t, api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": hdl, "name": "H"}), http.StatusCreated, "")
	p = decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{"name": p.Name, "status": "active", "expectedUpdatedAt": p.UpdatedAt,
		"productTypeIds": []any{w.c.KNX, w.c.Zigbee}}), http.StatusOK, "")
	want(t, api.Delete("/api/product-types/"+hdl.String(), admin), http.StatusConflict, "product_type.in_use")

	// An inactive type is refused.
	resp = api.Get("/api/product-types/"+w.c.KNX.String(), admin)
	knx := decode[map[string]any](t, resp)
	knx["isActive"] = false
	knx["expectedUpdatedAt"] = knx["updatedAt"]
	for _, k := range []string{"id", "createdAt", "updatedAt", "can", "sortOrder"} {
		delete(knx, k)
	}
	want(t, api.Put("/api/product-types/"+w.c.KNX.String(), admin, knx), http.StatusOK, "")
	resp = api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "K"})
	want(t, resp, http.StatusUnprocessableEntity, "")
	if !contains(resp.Body.String(), "bus_line.product_type_inactive") {
		t.Errorf("inactive: %s", resp.Body)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
