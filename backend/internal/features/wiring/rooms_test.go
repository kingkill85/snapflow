package wiring_test

import (
	"net/http"
	"testing"
	"time"

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
	sameAsChecks(t, r, w.checks(t))
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

// sameAsChecks: every room's counts and status equal the checks' zone, and
// the totals the checks' counts (one coverage rule, D455).
func sameAsChecks(t *testing.T, r wiring.Rooms, c wiring.Checks) {
	t.Helper()
	type key struct{ plan, zone uuid.UUID }
	zones := map[key]wiring.ZoneStatus{}
	for _, z := range c.Zones {
		k := key{plan: z.PlanID}
		if z.ZoneID != nil {
			k.zone = *z.ZoneID
		}
		zones[k] = z
	}
	n := 0
	for _, p := range r.Plans {
		for _, room := range p.Rooms {
			n++
			k := key{plan: p.PlanID}
			if room.ZoneID != nil {
				k.zone = *room.ZoneID
			}
			z, ok := zones[k]
			if !ok || z.Units != room.Units || z.ConnectedUnits != room.ConnectedUnits || z.Status != room.Status {
				t.Fatalf("room %+v, checks zone %+v", room, z)
			}
		}
	}
	if n != len(c.Zones) || r.Totals.Units != c.Counts.Units || r.Totals.ConnectedUnits != c.Counts.ConnectedUnits {
		t.Fatalf("rooms %+v, checks %+v", r.Totals, c.Counts)
	}
}

// TestRoomsErrorsReadOnlyAndNoZones: a connection with an error does not
// count (D412) in the rooms nor the checks; a floorplan without zones has no
// rooms; a completed project cannot be updated.
func TestRoomsErrorsReadOnlyAndNoZones(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	rooms := func() wiring.Rooms {
		t.Helper()
		resp := api.Get(w.url("/rooms"), cookie)
		want(t, resp, http.StatusOK, "")
		return decode[wiring.Rooms](t, resp)
	}
	want(t, api.Post(w.url("/connections"), cookie, w.connect(2, 1)), http.StatusCreated, "")
	r := rooms()
	if k := r.Plans[0].Rooms[0]; k.ConnectedUnits != 2 || k.Status != "partial" {
		t.Fatalf("kitchen %+v", k)
	}
	sameAsChecks(t, r, w.checks(t))

	// 2 × 60 W on a 100 W channel: the connection is overloaded (an error).
	c := decode[plans.PlanContent](t, api.Get("/api/plans/"+w.floor.String()+"/content", cookie))
	want(t, api.Put("/api/plans/"+w.floor.String()+"/content", cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "placements": []any{},
		"zones": []any{map[string]any{"id": w.zone, "name": "Kitchen", "color": "#aabbcc", "opacity": 0.3, "points": [][2]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}}}},
		"needs": []any{map[string]any{"id": w.need, "zoneId": w.zone, "functionTypeId": w.light, "quantity": 3, "powerW": "60", "loadTypeId": w.led,
			"label": "Spots", "note": "", "x": nil, "y": nil}},
	}), http.StatusOK, "")
	second := w.floorplan(t, "Upper")

	r = rooms()
	if k := r.Plans[0].Rooms[0]; k.ConnectedUnits != 0 || k.Status != "missing" || k.Needs[0].ConnectedUnits != 0 {
		t.Fatalf("kitchen with an overloaded connection %+v", k)
	}
	checks := w.checks(t)
	if checks.Counts.Errors == 0 {
		t.Fatalf("no error for the overloaded channel: %+v", checks.Findings)
	}
	sameAsChecks(t, r, checks)
	if len(r.Plans) != 2 || r.Plans[1].PlanID != second || len(r.Plans[1].Rooms) != 0 {
		t.Fatalf("plans %+v", r.Plans)
	}

	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{
		"name": p.Name, "status": "completed", "expectedUpdatedAt": p.UpdatedAt}), http.StatusOK, "")
	if r := rooms(); r.Can.Update {
		t.Fatal("a completed project can be updated")
	}
}
