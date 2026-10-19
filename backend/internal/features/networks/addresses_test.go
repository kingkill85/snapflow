package networks_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/networks/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

func addrOf(a networks.Addresses, item uuid.UUID) *networks.DeviceAddress {
	for _, it := range a.Items {
		if it.ItemID == item {
			return it.Address
		}
	}
	return nil
}

func TestParse(t *testing.T) {
	for s, ok := range map[string]bool{"1.1.1": true, "15.15.255": true, "15/15/255": false, "1.1/1": false, "16.1.1": false, "1.1.256": false, "1.1": false, "a.b.c": false} {
		if _, got := networks.ParseKNX(s); got != ok {
			t.Errorf("KNX %q: %v", s, got)
		}
	}
	for s, ok := range map[string]bool{"1.12": true, "254.254": true, "1.1": true, "255.1": false, "0.1": false, "1.0": false, "1.255": false, "1": false} {
		if _, got := networks.ParseHDL(s); got != ok {
			t.Errorf("HDL %q: %v", s, got)
		}
	}
	if v, ok := networks.ParseIEEE("00:12:4b:00:1c:a1:b2:c3"); !ok || v != "00124B001CA1B2C3" {
		t.Errorf("IEEE: %q %v", v, ok)
	}
	if _, ok := networks.ParseIEEE("00124B001CA1B2"); ok {
		t.Error("short IEEE accepted")
	}
}

func TestAddresses(t *testing.T) {
	w := setup(t)
	api, cookie, v := w.api, w.user.Cookie, w.version.String()
	act1, act2, psu, sensor, gw, bulb := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ground := w.floorplan(t, "Ground", [2]uuid.UUID{sensor, w.c.Sensor}, [2]uuid.UUID{gw, w.c.Gateway}, [2]uuid.UUID{bulb, w.c.Bulb})
	board := w.board(t, "Board", [2]uuid.UUID{act1, w.c.Actuator}, [2]uuid.UUID{psu, w.c.PSU}, [2]uuid.UUID{act2, w.c.Actuator})
	n := decode[networks.Networks](t, api.Get("/api/versions/"+v+"/networks", cookie))
	line := n.BusSystems[0].Lines[0]

	// Malformed line addresses are refused for KNX.
	want(t, api.Put("/api/versions/"+v+"/bus-lines/"+line.ID.String(), cookie, map[string]any{"name": line.Name, "address": "1-2"}),
		http.StatusUnprocessableEntity, "validation.failed")
	want(t, api.Put("/api/versions/"+v+"/bus-lines/"+line.ID.String(), cookie, map[string]any{"name": line.Name, "address": "1.2"}),
		http.StatusOK, "")

	a := decode[networks.Addresses](t, api.Get("/api/versions/"+v+"/addresses", cookie))
	if len(a.Items) != 6 || len(a.Lines) != 1 || a.Lines[0].Prefix != "1.2" || a.Lines[0].Default || !a.Can.Update {
		t.Fatalf("addresses: %+v", a)
	}

	// A pinned address by hand; wrong schemes and formats are refused.
	resp := api.Put("/api/versions/"+v+"/addresses", cookie, map[string]any{"addresses": []any{
		map[string]any{"planId": board, "itemId": act2, "knx": "1.2.1", "note": "by hand"},
		map[string]any{"planId": ground, "itemId": bulb, "ieee": "00:12:4b:00:1c:a1:b2:c3"},
	}})
	want(t, resp, http.StatusOK, "")
	want(t, api.Put("/api/versions/"+v+"/addresses", cookie, map[string]any{"addresses": []any{
		map[string]any{"planId": ground, "itemId": bulb, "knx": "1.2.9"},
		map[string]any{"planId": ground, "itemId": sensor, "knx": "1.2.300"},
		map[string]any{"planId": ground, "itemId": uuid.New(), "knx": "1.2.3"},
	}}), http.StatusUnprocessableEntity, "")
	want(t, api.Put("/api/versions/"+v+"/addresses", cookie, map[string]any{"addresses": []any{
		map[string]any{"planId": ground, "itemId": sensor, "knx": "1.2.1"},
	}}), http.StatusUnprocessableEntity, "")

	// Auto-assign: board modules first (act1), then the floorplan (sensor);
	// 1.2.1 is taken by hand; the power supply gets none.
	resp = api.Post("/api/versions/"+v+"/addresses/assign", cookie, map[string]any{})
	want(t, resp, http.StatusOK, "")
	r := decode[networks.AssignResult](t, resp)
	if r.Assigned != 2 || r.Unassigned != 0 {
		t.Errorf("assign: %d %d", r.Assigned, r.Unassigned)
	}
	if x := addrOf(r.Addresses, act1); x == nil || x.KNX != "1.2.2" || x.Pinned {
		t.Errorf("act1: %+v", x)
	}
	if x := addrOf(r.Addresses, sensor); x == nil || x.KNX != "1.2.3" {
		t.Errorf("sensor: %+v", x)
	}
	if x := addrOf(r.Addresses, act2); x == nil || x.KNX != "1.2.1" || !x.Pinned || x.Note != "by hand" {
		t.Errorf("act2: %+v", x)
	}
	if x := addrOf(r.Addresses, psu); x != nil {
		t.Errorf("psu: %+v", x)
	}
	// Deterministic: a second run gives the same.
	r2 := decode[networks.AssignResult](t, api.Post("/api/versions/"+v+"/addresses/assign", cookie, map[string]any{}))
	if addrOf(r2.Addresses, act1).KNX != "1.2.2" || addrOf(r2.Addresses, sensor).KNX != "1.2.3" {
		t.Error("assign not deterministic")
	}

	// Checks: an address outside its line, a duplicate made by changing the
	// line (both kept), none missing.
	want(t, api.Put("/api/versions/"+v+"/addresses", cookie, map[string]any{"addresses": []any{
		map[string]any{"planId": board, "itemId": act2, "knx": "1.5.1"}}}), http.StatusOK, "")
	checks := decode[struct {
		Findings []struct {
			Code     string
			Severity string
		}
	}](t, api.Get("/api/versions/"+v+"/checks", cookie))
	found := map[string]bool{}
	for _, f := range checks.Findings {
		found[f.Code] = true
	}
	if !found["address_outside_line"] || found["address_missing"] {
		t.Errorf("findings: %+v", checks.Findings)
	}

	// Version copy keeps the addresses (plan ids mapped).
	resp = api.Post("/api/projects/"+w.project.String()+"/versions", cookie, map[string]any{"name": "V2", "sourceVersionId": w.version})
	want(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	ca := decode[networks.Addresses](t, api.Get("/api/versions/"+target.String()+"/addresses", cookie))
	if x := addrOf(ca, act1); x == nil || x.KNX != "1.2.2" {
		t.Errorf("copied: %+v", x)
	}
	if x := addrOf(ca, bulb); x == nil || x.IEEE != "00124B001CA1B2C3" {
		t.Errorf("copied ieee: %+v", x)
	}

	// Clear the automatic ones: the pinned stay.
	want(t, api.Delete("/api/versions/"+v+"/addresses", cookie), http.StatusUnprocessableEntity, "")
	resp = api.Delete("/api/versions/"+v+"/addresses?auto=true", cookie)
	want(t, resp, http.StatusOK, "")
	a = decode[networks.Addresses](t, resp)
	if addrOf(a, act1) != nil || addrOf(a, sensor) != nil || addrOf(a, act2) == nil {
		t.Errorf("after clear: %+v", a.Items)
	}
	checks = decode[struct {
		Findings []struct {
			Code     string
			Severity string
		}
	}](t, api.Get("/api/versions/"+v+"/checks", cookie))
	found = map[string]bool{}
	for _, f := range checks.Findings {
		found[f.Code] = true
	}
	if !found["address_missing"] {
		t.Errorf("findings after clear: %+v", checks.Findings)
	}

	// Read-only projects refuse address changes; others see nothing.
	if _, err := api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, w.project); err != nil {
		t.Fatal(err)
	}
	want(t, api.Post("/api/versions/"+v+"/addresses/assign", cookie, map[string]any{}), http.StatusConflict, "project.read_only")
	want(t, api.Put("/api/versions/"+v+"/addresses", cookie, map[string]any{"addresses": []any{}}), http.StatusConflict, "project.read_only")
	if a := decode[networks.Addresses](t, api.Get("/api/versions/"+v+"/addresses", cookie)); a.Can.Update {
		t.Error("read-only can update")
	}
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	want(t, api.Get("/api/versions/"+v+"/addresses", other.Cookie), http.StatusNotFound, "")

	// Row-level security.
	ctx := t.Context()
	intruderTenant := api.NewTenant("Intruder")
	intruder := api.NewUser(intruderTenant, auth.RoleUser)
	tx, err := api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := database.SetScope(ctx, tx, auth.Actor{UserID: intruder.UserID, TenantID: intruderTenant, Role: auth.RoleUser}); err != nil {
		t.Fatal(err)
	}
	if rows, err := store.New(tx).ListAddresses(ctx, w.version); err != nil || len(rows) != 0 {
		t.Errorf("foreign addresses: %v %v", rows, err)
	}
}
