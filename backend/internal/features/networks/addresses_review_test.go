package networks_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
)

// addrWorld is a KNX board (two actuators), a floorplan (sensor, Zigbee
// gateway and bulb) and the version's KNX line.
type addrWorld struct {
	world
	board, ground                uuid.UUID
	act1, act2, sensor, gw, bulb uuid.UUID
	v                            string
	line                         networks.BusLine
}

func setupAddresses(t *testing.T) addrWorld {
	w := addrWorld{world: setup(t)}
	w.act1, w.act2, w.sensor, w.gw, w.bulb = uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	w.ground = w.floorplan(t, "Ground", [2]uuid.UUID{w.sensor, w.c.Sensor}, [2]uuid.UUID{w.gw, w.c.Gateway}, [2]uuid.UUID{w.bulb, w.c.Bulb})
	w.board = w.world.board(t, "Board", [2]uuid.UUID{w.act1, w.c.Actuator}, [2]uuid.UUID{w.act2, w.c.Actuator})
	w.v = w.version.String()
	w.line = w.lines(t, w.user.Cookie)[0]
	return w
}

func (w addrWorld) put(addresses ...map[string]any) *httptest.ResponseRecorder {
	list := make([]any, len(addresses))
	for i, a := range addresses {
		list[i] = a
	}
	return w.api.Put("/api/versions/"+w.v+"/addresses", w.user.Cookie, map[string]any{"addresses": list})
}

func (w addrWorld) get(t *testing.T) networks.Addresses {
	t.Helper()
	return decode[networks.Addresses](t, w.api.Get("/api/versions/"+w.v+"/addresses", w.user.Cookie))
}

func (w addrWorld) findings(t *testing.T) map[string]int {
	t.Helper()
	checks := decode[struct{ Findings []struct{ Code string } }](t, w.api.Get("/api/versions/"+w.v+"/checks", w.user.Cookie))
	out := map[string]int{}
	for _, f := range checks.Findings {
		out[f.Code]++
	}
	return out
}

func wantTaken(t *testing.T, resp *httptest.ResponseRecorder) {
	t.Helper()
	if resp.Code != http.StatusUnprocessableEntity || !strings.Contains(resp.Body.String(), "address.taken") {
		t.Fatalf("want address.taken, got %d: %s", resp.Code, resp.Body)
	}
}

func TestAddressTakenAndNormalised(t *testing.T) {
	w := setupAddresses(t)
	want(t, w.put(map[string]any{"planId": w.board, "itemId": w.act1, "knx": "1.1.7"}), http.StatusOK, "")
	wantTaken(t, w.put(map[string]any{"planId": w.ground, "itemId": w.sensor, "knx": "1.1.7"}))
	// "/" writes group addresses: refused for individual addresses.
	resp := w.put(map[string]any{"planId": w.ground, "itemId": w.sensor, "knx": "1/1/8"})
	if resp.Code != http.StatusUnprocessableEntity || !strings.Contains(resp.Body.String(), "address.knx_invalid") {
		t.Fatalf("slash: %d %s", resp.Code, resp.Body)
	}
	want(t, w.api.Put("/api/versions/"+w.v+"/bus-lines/"+w.line.ID.String(), w.user.Cookie, map[string]any{"name": w.line.Name, "address": "1/3"}),
		http.StatusUnprocessableEntity, "validation.failed")

	// IEEE: separators, case and 0x are normalised to 16 upper hex digits.
	for _, in := range []string{"00:12:4b:00:1c:a1:b2:c3", "0x00124b001ca1b2c3", "00-12-4B-00-1C-A1-B2-C3", "00 12 4b 00 1c a1 b2 c3"} {
		resp := w.put(map[string]any{"planId": w.ground, "itemId": w.bulb, "ieee": in})
		want(t, resp, http.StatusOK, "")
		if x := addrOf(decode[networks.Addresses](t, resp), w.bulb); x == nil || x.IEEE != "00124B001CA1B2C3" || !x.Pinned {
			t.Errorf("%q: %+v", in, x)
		}
	}
	// The gateway cannot take the bulb's IEEE address.
	wantTaken(t, w.put(map[string]any{"planId": w.ground, "itemId": w.gw, "ieee": "0x00124B001CA1B2C3"}))

	// KNX device 0 is the coupler's: accepted with a warning.
	want(t, w.put(map[string]any{"planId": w.board, "itemId": w.act2, "knx": "1.1.0"}), http.StatusOK, "")
	if f := w.findings(t); f["address_device_zero"] != 1 {
		t.Errorf("findings %v", f)
	}
}

// A note alone is not pinned: auto-assign gives the device a number and
// keeps the note.
func TestNoteOnlyIsAutomatic(t *testing.T) {
	w := setupAddresses(t)
	resp := w.put(map[string]any{"planId": w.board, "itemId": w.act1, "note": "behind the door"})
	want(t, resp, http.StatusOK, "")
	if x := addrOf(decode[networks.Addresses](t, resp), w.act1); x == nil || x.Pinned || x.KNX != "" || x.Note != "behind the door" {
		t.Fatalf("note only: %+v", x)
	}
	r := decode[networks.AssignResult](t, w.api.Post("/api/versions/"+w.v+"/addresses/assign", w.user.Cookie, map[string]any{}))
	if x := addrOf(r.Addresses, w.act1); x == nil || x.KNX != "1.1.1" || x.Pinned || x.Note != "behind the door" {
		t.Errorf("assigned: %+v", x)
	}
	// Clearing the automatic addresses keeps the note.
	a := decode[networks.Addresses](t, w.api.Delete("/api/versions/"+w.v+"/addresses?auto=true", w.user.Cookie))
	if x := addrOf(a, w.act1); x == nil || x.KNX != "" || x.Note != "behind the door" {
		t.Errorf("cleared: %+v", x)
	}
	if x := addrOf(a, w.act2); x != nil {
		t.Errorf("act2 kept: %+v", x)
	}
}

// Rows of removed items do not block their address and are deleted by the
// next address write.
func TestDanglingRowsDropped(t *testing.T) {
	w := setupAddresses(t)
	want(t, w.put(map[string]any{"planId": w.ground, "itemId": w.sensor, "knx": "1.1.9", "note": "old"}), http.StatusOK, "")
	// Remove the sensor from the floorplan.
	content := decode[plans.PlanContent](t, w.api.Get("/api/plans/"+w.ground.String()+"/content", w.user.Cookie))
	list := []any{}
	for _, it := range [][2]uuid.UUID{{w.gw, w.c.Gateway}, {w.bulb, w.c.Bulb}} {
		list = append(list, map[string]any{"id": it[0], "variantId": it[1], "x": 5, "y": 5, "width": 1, "height": 1, "rotation": 0,
			"label": "", "existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}})
	}
	want(t, w.api.Put("/api/plans/"+w.ground.String()+"/content", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": content.ContentUpdatedAt, "scale": nil, "zones": []any{}, "placements": list}), http.StatusOK, "")

	want(t, w.put(map[string]any{"planId": w.board, "itemId": w.act1, "knx": "1.1.9"}), http.StatusOK, "")
	var n int
	if err := w.api.DB.QueryRow(t.Context(), `SELECT count(*) FROM device_addresses WHERE item_id = $1`, w.sensor).Scan(&n); err != nil || n != 0 {
		t.Errorf("dangling rows %d %v", n, err)
	}
}

// Two writers setting the same address at once: one wins, the other gets
// address.taken (the second validates under the version lock).
func TestConcurrentSetSameAddress(t *testing.T) {
	w := setupAddresses(t)
	for round := range 5 {
		addr := "1.1." + string(rune('1'+round))
		var wg sync.WaitGroup
		resps := make([]*httptest.ResponseRecorder, 2)
		for i, it := range [][2]uuid.UUID{{w.board, w.act1}, {w.ground, w.sensor}} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				resps[i] = w.put(map[string]any{"planId": it[0], "itemId": it[1], "knx": addr})
			}()
		}
		wg.Wait()
		ok, taken := 0, 0
		for _, r := range resps {
			switch {
			case r.Code == http.StatusOK:
				ok++
			case r.Code == http.StatusUnprocessableEntity && strings.Contains(r.Body.String(), "address.taken"):
				taken++
			default:
				t.Fatalf("unexpected %d: %s", r.Code, r.Body)
			}
		}
		if ok != 1 || taken != 1 {
			t.Fatalf("round %d: ok %d taken %d", round, ok, taken)
		}
		// Clear both for the next round.
		want(t, w.put(map[string]any{"planId": w.board, "itemId": w.act1}, map[string]any{"planId": w.ground, "itemId": w.sensor}), http.StatusOK, "")
	}
}

// Auto-assign and a pin at once never leave a duplicate.
func TestConcurrentAssignAndPin(t *testing.T) {
	w := setupAddresses(t)
	for range 5 {
		want(t, w.api.Delete("/api/versions/"+w.v+"/addresses?auto=true", w.user.Cookie), http.StatusOK, "")
		want(t, w.put(map[string]any{"planId": w.ground, "itemId": w.sensor}), http.StatusOK, "")
		var wg sync.WaitGroup
		var assign, pin *httptest.ResponseRecorder
		wg.Add(2)
		go func() {
			defer wg.Done()
			assign = w.api.Post("/api/versions/"+w.v+"/addresses/assign", w.user.Cookie, map[string]any{})
		}()
		go func() {
			defer wg.Done()
			pin = w.put(map[string]any{"planId": w.ground, "itemId": w.sensor, "knx": "1.1.1"})
		}()
		wg.Wait()
		want(t, assign, http.StatusOK, "")
		if pin.Code != http.StatusOK {
			wantTaken(t, pin)
		}
		seen := map[string]bool{}
		for _, it := range w.get(t).Items {
			if it.Address == nil || it.Address.KNX == "" {
				continue
			}
			if seen[it.Address.KNX] {
				t.Fatalf("duplicate %s", it.Address.KNX)
			}
			seen[it.Address.KNX] = true
		}
	}
}

// Default prefixes skip prefixes other lines use; two lines with the same
// address field are a warning.
func TestLinePrefixCollision(t *testing.T) {
	w := setupAddresses(t)
	resp := w.api.Post("/api/versions/"+w.v+"/bus-lines", w.user.Cookie, map[string]any{"productTypeId": w.c.KNX, "name": "Line 2"})
	want(t, resp, http.StatusCreated, "")
	line2 := decode[networks.BusLine](t, resp)
	prefixes := func() map[uuid.UUID]networks.LinePrefix {
		out := map[uuid.UUID]networks.LinePrefix{}
		for _, l := range w.get(t).Lines {
			out[l.BusLineID] = l
		}
		return out
	}
	if p := prefixes(); p[w.line.ID].Prefix != "1.1" || p[line2.ID].Prefix != "1.2" || !p[line2.ID].Default {
		t.Fatalf("defaults %+v", p)
	}
	// Line 1 takes 1.2 by its address field: line 2's default moves to 1.1.
	want(t, w.api.Put("/api/versions/"+w.v+"/bus-lines/"+w.line.ID.String(), w.user.Cookie, map[string]any{"name": w.line.Name, "address": "1.2"}),
		http.StatusOK, "")
	if p := prefixes(); p[w.line.ID].Prefix != "1.2" || p[line2.ID].Prefix != "1.1" {
		t.Fatalf("skipped %+v", p)
	}
	if f := w.findings(t); f["bus_line_address_duplicate"] != 0 {
		t.Errorf("findings %v", f)
	}
	// Both with 1.2: a warning per line.
	want(t, w.api.Put("/api/versions/"+w.v+"/bus-lines/"+line2.ID.String(), w.user.Cookie, map[string]any{"name": line2.Name, "address": "1.2"}),
		http.StatusOK, "")
	if f := w.findings(t); f["bus_line_address_duplicate"] != 2 {
		t.Errorf("findings %v", f)
	}
}

func TestClearAutomaticReadOnly(t *testing.T) {
	w := setupAddresses(t)
	if _, err := w.api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, w.project); err != nil {
		t.Fatal(err)
	}
	want(t, w.api.Delete("/api/versions/"+w.v+"/addresses?auto=true", w.user.Cookie), http.StatusConflict, "project.read_only")
}
