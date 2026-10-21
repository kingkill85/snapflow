package wiring_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// TestRooms: every zone of the floorplan (one without needs), the needs
// outside every zone last, connected units with a circuit (two units on one
// channel) and partial units, totals and per function type; boards are not
// rooms.
func TestRooms(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	rooms := func() wiring.Rooms {
		t.Helper()
		resp := api.Get(w.url("/rooms"), cookie)
		want(t, resp, http.StatusOK, "")
		return decode[wiring.Rooms](t, resp)
	}

	r := rooms()
	if len(r.Plans) != 1 || r.Plans[0].PlanID != w.floor || len(r.Plans[0].Rooms) != 1 || !r.Can.Update {
		t.Fatalf("rooms %+v", r)
	}
	if k := r.Plans[0].Rooms[0]; k.Name != "Kitchen" || k.Units != 3 || k.ConnectedUnits != 0 || k.Status != "missing" || len(k.Needs) != 1 ||
		k.Needs[0].FunctionType.Key != "light" || *k.Needs[0].PowerW != "40.00" {
		t.Fatalf("kitchen %+v", k)
	}

	// A second zone (no needs, short name) and a need outside every zone.
	hall, outside := uuid.New(), uuid.New()
	c := decode[plans.PlanContent](t, api.Get("/api/plans/"+w.floor.String()+"/content", cookie))
	want(t, api.Put("/api/plans/"+w.floor.String()+"/content", cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "placements": []any{},
		"zones": []any{
			map[string]any{"id": w.zone, "name": "Kitchen", "color": "#aabbcc", "opacity": 0.3, "points": [][2]float64{{0, 0}, {5, 0}, {5, 5}, {0, 5}}},
			map[string]any{"id": hall, "name": "Hall", "shortName": "HL", "color": "#aabbcc", "opacity": 0.3, "points": [][2]float64{{6, 0}, {9, 0}, {9, 4}, {6, 4}}},
		},
		"needs": []any{
			map[string]any{"id": w.need, "zoneId": w.zone, "functionTypeId": w.light, "quantity": 3, "powerW": "40", "loadTypeId": w.led,
				"label": "Spots", "note": "", "x": nil, "y": nil},
			map[string]any{"id": outside, "zoneId": nil, "functionTypeId": w.light, "quantity": 1, "powerW": "10", "loadTypeId": w.led,
				"label": "Terrace", "note": "", "x": 8, "y": 8},
		},
	}), http.StatusOK, "")

	// Circuit: two kitchen units on channel 1 (80 W); the outside need on
	// channel 2.
	want(t, api.Post(w.url("/connections"), cookie, w.connect(2, 1)), http.StatusCreated, "")
	out := w.connect(1, 2)
	out["needId"] = outside
	want(t, api.Post(w.url("/connections"), cookie, out), http.StatusCreated, "")

	r = rooms()
	got := r.Plans[0].Rooms
	if len(got) != 3 {
		t.Fatalf("rooms %+v", got)
	}
	if k := got[0]; k.Status != "partial" || k.Units != 3 || k.ConnectedUnits != 2 || k.Needs[0].ConnectedUnits != 2 {
		t.Fatalf("kitchen %+v", k)
	}
	if h := got[1]; h.Name != "Hall" || h.ShortName != "HL" || h.Status != "none" || h.Units != 0 || len(h.Needs) != 0 {
		t.Fatalf("hall %+v", h)
	}
	if o := got[2]; o.ZoneID != nil || o.Name != "" || o.Status != "covered" || o.Units != 1 || o.ConnectedUnits != 1 || o.Needs[0].Label != "Terrace" {
		t.Fatalf("outside %+v", o)
	}
	if tt := r.Totals; tt.Needs != 2 || tt.Units != 4 || tt.ConnectedUnits != 3 || tt.PowerW != "130.00" {
		t.Fatalf("totals %+v", tt)
	}
	if len(r.FunctionTypes) != 1 || r.FunctionTypes[0].FunctionType.Key != "light" || r.FunctionTypes[0].Counts.Units != 4 {
		t.Fatalf("function types %+v", r.FunctionTypes)
	}

	// The last kitchen unit on channel 2 (40 W + 10 W): covered.
	want(t, api.Post(w.url("/connections"), cookie, w.connect(1, 2)), http.StatusCreated, "")
	if k := rooms().Plans[0].Rooms[0]; k.Status != "covered" || k.ConnectedUnits != 3 {
		t.Fatalf("kitchen %+v", k)
	}

	// Other tenants do not see the version.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	want(t, api.Get(w.url("/rooms"), other.Cookie), http.StatusNotFound, "")
}
