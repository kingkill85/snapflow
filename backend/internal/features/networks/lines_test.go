package networks_test

import (
	"net/http"
	"sync"
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

// D372, D451: the first line ("Line 1") comes with a content save, GET
// never writes, the last line of a system with devices stays.
func TestDefaultLineOnSave(t *testing.T) {
	w := setup(t)
	api, v := w.api, w.version.String()
	act, gw := uuid.New(), uuid.New()

	// A board without bus modules and a floorplan with only a wireless
	// gateway create nothing.
	board := w.board(t, "Board")
	w.floorplan(t, "Ground", [2]uuid.UUID{gw, w.c.Gateway})
	if l := w.lines(t, w.user.Cookie); len(l) != 0 {
		t.Fatalf("lines without bus members: %+v", l)
	}
	// Saving a bus module creates "Line 1" (the project is en); a second
	// save creates no other.
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator})
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator}, [2]uuid.UUID{uuid.New(), w.c.PSU})
	l := w.lines(t, w.user.Cookie)
	if len(l) != 1 || l[0].Name != "Line 1" || l[0].ProductTypeID != w.c.KNX {
		t.Fatalf("default line: %+v", l)
	}
	// The only line of a system with devices cannot be deleted.
	resp := api.Delete("/api/versions/"+v+"/bus-lines/"+l[0].ID.String(), w.user.Cookie)
	want(t, resp, http.StatusConflict, "bus_line.last_with_devices")
	if !contains(resp.Body.String(), `"count":2`) {
		t.Errorf("count: %s", resp.Body)
	}
	// Without devices it can; GET creates nothing, the next save with a
	// device brings it back.
	w.saveBoard(t, board)
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+l[0].ID.String(), w.user.Cookie), http.StatusNoContent, "")
	w.saveBoard(t, board, [2]uuid.UUID{act, w.c.Actuator})
	l = w.lines(t, w.user.Cookie)
	if len(l) != 1 || l[0].Name != "Line 1" {
		t.Fatalf("default line again: %+v", l)
	}

	// Members without a line (a line removed outside the API, data from
	// before D451) are unassigned; GET creates nothing (every role writes;
	// read-only projects below).
	if _, err := api.DB.Exec(t.Context(), `DELETE FROM bus_lines WHERE version_id = $1`, w.version); err != nil {
		t.Fatal(err)
	}
	for _, cookie := range []string{w.user.Cookie, api.Admin.Cookie} {
		n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
		if len(n.BusSystems) != 1 || len(n.BusSystems[0].Lines) != 0 || len(n.BusSystems[0].Unassigned) != 1 {
			t.Errorf("no line: %+v", n.BusSystems)
		}
		if len(w.lines(t, cookie)) != 0 {
			t.Errorf("GET created a line")
		}
	}

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

// D451: the line's name is in the project's language; two bus systems get
// a line each; the last line refusal is per system.
func TestDefaultLineLanguageAndSystems(t *testing.T) {
	w := setup(t)
	api, admin, cookie, v := w.api, w.api.Admin.Cookie, w.user.Cookie, w.version.String()
	text := func(en string) map[string]string { return map[string]string{"en": en} }
	resp := api.Post("/api/product-types", admin, map[string]any{"key": "hdl", "name": text("HDL"), "abbreviation": "HDL", "isActive": true, "topology": "bus"})
	want(t, resp, http.StatusCreated, "")
	hdl := decode[struct{ ID uuid.UUID }](t, resp).ID
	cat := decode[struct {
		Items []struct {
			ID  uuid.UUID
			Key string
		}
	}](t, api.Get("/api/categories", admin))
	var boardCat uuid.UUID
	for _, c := range cat.Items {
		if c.Key == "board_devices" {
			boardCat = c.ID
		}
	}
	resp = api.Post("/api/products", admin, map[string]any{"productTypeId": hdl, "categoryId": boardCat, "modelNumber": "HDL-ACT",
		"name": text("HDL-ACT"), "isActive": true, "attributes": map[string]any{"width_te": 4}})
	want(t, resp, http.StatusCreated, "")
	prod := decode[struct{ ID uuid.UUID }](t, resp).ID
	resp = api.Post("/api/products/"+prod.String()+"/variants", admin, map[string]any{"name": text("HDL-ACT"), "price": "10.00", "isActive": true})
	want(t, resp, http.StatusCreated, "")
	hdlAct := decode[struct{ ID uuid.UUID }](t, resp).ID

	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{"name": p.Name, "status": "active", "language": "de",
		"expectedUpdatedAt": p.UpdatedAt, "productTypeIds": []any{w.c.KNX, w.c.Zigbee, hdl}}), http.StatusOK, "")

	w.board(t, "Board", [2]uuid.UUID{uuid.New(), w.c.Actuator}, [2]uuid.UUID{uuid.New(), hdlAct})
	l := w.lines(t, cookie)
	if len(l) != 2 || l[0].Name != "Linie 1" || l[1].Name != "Linie 1" || l[0].ProductTypeID == l[1].ProductTypeID {
		t.Fatalf("two systems: %+v", l)
	}
	// With a second KNX line, the first one can go (its default members
	// follow the remaining line, D360); the HDL line cannot.
	resp = api.Post("/api/versions/"+v+"/bus-lines", cookie, map[string]any{"productTypeId": w.c.KNX, "name": "Linie 2"})
	want(t, resp, http.StatusCreated, "")
	line2 := decode[networks.BusLine](t, resp)
	for _, x := range l {
		if x.ProductTypeID == hdl {
			want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+x.ID.String(), cookie), http.StatusConflict, "bus_line.last_with_devices")
		} else {
			want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+x.ID.String(), cookie), http.StatusNoContent, "")
		}
	}
	want(t, api.Delete("/api/versions/"+v+"/bus-lines/"+line2.ID.String(), cookie), http.StatusConflict, "bus_line.last_with_devices")
}

// D451: saves of two plans of one version at once create one line; a
// version copy keeps it and creates no second one.
func TestDefaultLineConcurrentAndCopy(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	a, b := w.board(t, "A"), w.board(t, "B")
	var wg sync.WaitGroup
	for _, id := range []uuid.UUID{a, b} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.saveBoard(t, id, [2]uuid.UUID{uuid.New(), w.c.Actuator})
		}()
	}
	wg.Wait()
	if l := w.lines(t, cookie); len(l) != 1 || l[0].Name != "Line 1" {
		t.Fatalf("concurrent saves: %+v", l)
	}

	resp := api.Post("/api/projects/"+w.project.String()+"/versions", cookie, map[string]any{"name": "Copy", "sourceVersionId": w.version})
	want(t, resp, http.StatusCreated, "")
	copied := world{api: api, c: w.c, user: w.user, project: w.project, version: decode[struct{ ID uuid.UUID }](t, resp).ID}
	l := copied.lines(t, cookie)
	if len(l) != 1 || l[0].Name != "Line 1" {
		t.Fatalf("copy: %+v", l)
	}
	n := decode[networks.Networks](t, api.Get("/api/versions/"+copied.version.String()+"/networks", cookie))
	if len(n.BusSystems[0].Lines[0].Members) != 2 {
		t.Errorf("copy members: %+v", n.BusSystems[0].Lines)
	}
	plansOf := decode[[]struct{ ID uuid.UUID }](t, api.Get("/api/versions/"+copied.version.String()+"/plans", cookie))
	want(t, api.Post("/api/plans/"+plansOf[0].ID.String()+"/lock", cookie), http.StatusOK, "")
	copied.saveBoard(t, plansOf[0].ID, [2]uuid.UUID{uuid.New(), w.c.Actuator})
	if l := copied.lines(t, cookie); len(l) != 1 {
		t.Errorf("save in the copy: %+v", l)
	}
}

// D452: devices without an explicit row are members of the system's line,
// marked not pinned, in the view and in the checks (capacity counts them).
func TestDefaultMembersInViewAndChecks(t *testing.T) {
	w := setup(t)
	api, cookie, v := w.api, w.user.Cookie, w.version.String()
	w.board(t, "Board", [2]uuid.UUID{uuid.New(), w.c.PSU}, [2]uuid.UUID{uuid.New(), w.c.Actuator}, [2]uuid.UUID{uuid.New(), w.c.Actuator})
	n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
	line := n.BusSystems[0].Lines[0]
	if len(line.Members) != 3 || len(n.BusSystems[0].Unassigned) != 0 || line.BusCurrentUsedMa != 20 || line.BusCurrentSuppliedMa != 640 {
		t.Fatalf("line: %+v", line)
	}
	for _, m := range line.Members {
		if m.Pinned {
			t.Errorf("default member pinned: %+v", m)
		}
	}
	checks := decode[struct {
		BusLines []struct {
			BusLineID         uuid.UUID
			Devices           int
			CurrentUsedMa     float64
			CurrentSuppliedMa float64
			CurrentStatus     string
		}
		Findings []struct{ Code string }
	}](t, api.Get("/api/versions/"+v+"/checks", cookie))
	if len(checks.BusLines) != 1 || checks.BusLines[0].BusLineID != line.ID || checks.BusLines[0].Devices != 3 ||
		checks.BusLines[0].CurrentUsedMa != 20 || checks.BusLines[0].CurrentSuppliedMa != 640 || checks.BusLines[0].CurrentStatus != "ok" {
		t.Errorf("checks: %+v", checks.BusLines)
	}
	for _, f := range checks.Findings {
		if f.Code == "bus_device_unassigned" || f.Code == "bus_line_no_power_supply" {
			t.Errorf("finding %s", f.Code)
		}
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
