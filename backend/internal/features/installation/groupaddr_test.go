package installation

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/installation/store"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// gaWorld builds data in memory: plans with zones, needs on one KNX item.
type gaWorld struct {
	d        *data
	fn       uuid.UUID
	actuator [2]uuid.UUID
}

func newGAWorld(objects ...string) *gaWorld {
	w := &gaWorld{fn: uuid.New()}
	var objs []functiontypes.KNXObject
	for _, o := range objects {
		objs = append(objs, functiontypes.KNXObject{Key: o, Name: i18n.Text{"en": strings.ToUpper(o[:1]) + o[1:]}, DPST: "DPST-1-1"})
	}
	w.d = &data{lang: tr("en"), ref: projects.VersionRef{ID: uuid.New(), TenantID: uuid.New()},
		functions: map[uuid.UUID]functiontypes.FunctionType{w.fn: {ID: w.fn, Key: "light", Name: i18n.Text{"en": "Light"}, KNXObjects: objs}},
		itemByKey: map[[2]uuid.UUID]*itemRef{}}
	board := uuid.New()
	w.actuator = [2]uuid.UUID{board, uuid.New()}
	w.d.addresses.Items = append(w.d.addresses.Items, networks.AddressedItem{ItemRef: networks.ItemRef{PlanID: board, ItemID: w.actuator[1]},
		Scheme: networks.SchemeKNX})
	return w
}

func (w *gaWorld) plan(name string) uuid.UUID {
	id := uuid.New()
	w.d.plans = append(w.d.plans, plans.Plan{ID: id, Name: name, Kind: plans.KindFloorplan})
	return id
}

func (w *gaWorld) zone(plan uuid.UUID, name string) *uuid.UUID {
	id := uuid.New()
	w.d.checks.Zones = append(w.d.checks.Zones, wiring.ZoneStatus{PlanID: plan, ZoneID: &id, Name: name})
	return &id
}

func (w *gaWorld) need(plan uuid.UUID, zone *uuid.UUID, label string) uuid.UUID {
	id := uuid.New()
	w.d.wiring.Needs = append(w.d.wiring.Needs, wiring.NeedInfo{PlanID: plan, NeedID: id, ZoneID: zone, Label: label, FunctionTypeID: w.fn})
	w.d.wiring.Connections = append(w.d.wiring.Connections, wiring.Connection{NeedPlanID: plan, NeedID: id,
		TargetPlanID: w.actuator[0], TargetItemID: w.actuator[1], ChannelNo: 1})
	return id
}

func (w *gaWorld) remove(need uuid.UUID) {
	for i, n := range w.d.wiring.Needs {
		if n.NeedID == need {
			w.d.wiring.Needs = append(w.d.wiring.Needs[:i], w.d.wiring.Needs[i+1:]...)
			break
		}
	}
	for i, c := range w.d.wiring.Connections {
		if c.NeedID == need {
			w.d.wiring.Connections = append(w.d.wiring.Connections[:i], w.d.wiring.Connections[i+1:]...)
			break
		}
	}
}

// store applies an assignment to the in-memory "tables".
type gaStore struct {
	groups []store.GroupAddressGroup
	rows   []store.GroupAddress
}

func (s *gaStore) assign(t *testing.T, d *data) gaPlan {
	t.Helper()
	res, err := planGroupAddresses(d, s.groups, s.rows, true)
	if err != nil {
		t.Fatal(err)
	}
	s.groups = append(s.groups, res.newGroups...)
	for _, u := range res.upserts {
		found := false
		for i, r := range s.rows {
			if r.NeedPlanID == u.NeedPlanID && r.NeedID == u.NeedID && r.ObjectKey == u.ObjectKey {
				s.rows[i], found = u, true
			}
		}
		if !found {
			s.rows = append(s.rows, u)
		}
	}
	return res
}

func addresses(gs []GroupAddress) map[string]string {
	out := map[string]string{}
	for _, g := range gs {
		out[g.Address()] = g.Name
	}
	return out
}

func TestObjectsFromFunctionType(t *testing.T) {
	w := newGAWorld("switch", "status")
	p := w.plan("Ground floor")
	z := w.zone(p, "Kitchen")
	w.need(p, z, "Spots")
	var s gaStore
	got := addresses(s.assign(t, w.d).list)
	want := map[string]string{"1/-/-": "Ground floor", "1/0/-": "Kitchen", "1/0/1": "Kitchen Spots Switch", "1/0/2": "Kitchen Spots Status"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %v", got)
	}
	// A function type without objects has no group addresses.
	w.d.functions[w.fn] = functiontypes.FunctionType{ID: w.fn, Name: i18n.Text{"en": "Light"}}
	if res, _ := planGroupAddresses(w.d, nil, nil, true); len(res.list) != 0 {
		t.Errorf("without objects: %v", res.list)
	}
}

func TestPastEightZones(t *testing.T) {
	w := newGAWorld("switch")
	p := w.plan("Ground floor")
	for i := range 9 {
		w.need(p, w.zone(p, fmt.Sprintf("Z%d", i+1)), "L")
	}
	var s gaStore
	got := addresses(s.assign(t, w.d).list)
	if got["1/-/-"] != "Ground floor (1)" || got["1/7/1"] != "Z8 L Switch" || got["2/-/-"] != "Ground floor (2)" || got["2/0/-"] != "Z9" {
		t.Errorf("got %v", got)
	}
	// Exactly 8 zones without needs outside zones: one main group, no "No zone".
	w = newGAWorld("switch")
	p = w.plan("Ground floor")
	for i := range 8 {
		w.need(p, w.zone(p, fmt.Sprintf("Z%d", i+1)), "L")
	}
	s = gaStore{}
	got = addresses(s.assign(t, w.d).list)
	if _, ok := got["2/-/-"]; ok || got["1/-/-"] != "Ground floor" || len(s.groups) != 8 {
		t.Errorf("8 zones: %v (%d groups)", got, len(s.groups))
	}
	// A need outside zones adds "No zone" in the next main group.
	w.need(p, nil, "Hall")
	got = addresses(s.assign(t, w.d).list)
	if got["2/0/-"] != "No zone" || got["2/0/1"] != "No zone Hall Switch" {
		t.Errorf("no zone: %v", got)
	}
}

func TestTooManyGroupAddresses(t *testing.T) {
	isTooMany := func(err error) bool {
		var ae *apperr.Error
		return errors.As(err, &ae) && ae.Status == 422 && ae.Code == "export.too_many_group_addresses"
	}
	// More plans than main groups 1-31.
	w := newGAWorld("switch")
	for i := range 32 {
		p := w.plan(fmt.Sprintf("P%d", i))
		w.need(p, w.zone(p, "Z"), "L")
	}
	if _, err := planGroupAddresses(w.d, nil, nil, true); !isTooMany(err) {
		t.Errorf("mains: %v", err)
	}
	// More than 255 group addresses in a zone.
	w = newGAWorld("a", "b")
	p := w.plan("P")
	z := w.zone(p, "Z")
	for range 128 {
		w.need(p, z, "L")
	}
	if _, err := planGroupAddresses(w.d, nil, nil, true); !isTooMany(err) {
		t.Errorf("subs: %v", err)
	}
}

func TestStableNumbers(t *testing.T) {
	w := newGAWorld("switch")
	p := w.plan("Ground floor")
	kitchen := w.zone(p, "Kitchen")
	a := w.need(p, kitchen, "Spots")
	b := w.need(p, kitchen, "Spots")
	var s gaStore
	got := addresses(s.assign(t, w.d).list)
	// Repeated labels in a zone get their number.
	if got["1/0/1"] != "Kitchen Spots 1 Switch" || got["1/0/2"] != "Kitchen Spots 2 Switch" {
		t.Fatalf("got %v", got)
	}
	// A new zone before the kitchen and a new need: existing numbers stay,
	// the new need takes the next free sub, the new zone the next middle.
	hall := uuid.New()
	w.d.checks.Zones = append([]wiring.ZoneStatus{{PlanID: p, ZoneID: &hall, Name: "Hall"}}, w.d.checks.Zones...)
	w.need(p, &hall, "Ceiling")
	c := w.need(p, kitchen, "Island")
	res := s.assign(t, w.d)
	got = addresses(res.list)
	if res.added != 2 || got["1/0/3"] != "Kitchen Island Switch" || got["1/1/1"] != "Hall Ceiling Switch" {
		t.Errorf("after adding: %v", got)
	}
	// Removing a need leaves a gap; its number is not reused.
	w.remove(a)
	s.assign(t, w.d)
	w.need(p, kitchen, "Fridge")
	got = addresses(s.assign(t, w.d).list)
	if _, ok := got["1/0/1"]; ok || got["1/0/2"] != "Kitchen Spots Switch" || got["1/0/3"] != "Kitchen Island Switch" || got["1/0/4"] != "Kitchen Fridge Switch" {
		t.Errorf("after removing: %v", got)
	}
	_, _ = b, c
	// Without add (an export of stored rows) new needs are left out.
	w.need(p, kitchen, "New")
	res, err := planGroupAddresses(w.d, s.groups, s.rows, false)
	if err != nil || len(res.upserts) != 0 || addresses(res.list)["1/0/5"] != "" {
		t.Errorf("export without assign: %v %v", res.list, err)
	}
}

func TestGANameLength(t *testing.T) {
	w := newGAWorld("switch")
	p := w.plan("P")
	w.need(p, w.zone(p, "Z"), strings.Repeat("ä", 300))
	var s gaStore
	for _, g := range s.assign(t, w.d).list {
		if n := len([]rune(g.Name)); n > 255 {
			t.Errorf("%s: %d characters", g.Address(), n)
		}
	}
}

func TestGroupAddressCSVFormats(t *testing.T) {
	gs := []GroupAddress{{Level: 1, Main: 1, Name: "Ground floor"}, {Level: 2, Main: 1, Name: "Living"},
		{Level: 3, Main: 1, Sub: 1, Name: `Living "Spots" Switch`, Description: "D2 Dimmer 1", DPT: "DPST-1-1"},
		{Level: 3, Main: 1, Sub: 2, Name: "-1 =SUM(A1)", Description: "@x", DPT: "DPST-5-1"}}
	got := string(groupAddressCSV(gs, FormatETS11))
	golden := "\ufeff" + strings.Join([]string{
		"\"Group name\"\t\"Address\"\t\"Central\"\t\"Unfiltered\"\t\"Description\"\t\"DatapointType\"\t\"Security\"",
		"\"Ground floor\"\t\"1/-/-\"\t\"\"\t\"\"\t\"\"\t\"\"\t\"Auto\"",
		"\"Living\"\t\"1/0/-\"\t\"\"\t\"\"\t\"\"\t\"\"\t\"Auto\"",
		"\"Living \"\"Spots\"\" Switch\"\t\"1/0/1\"\t\"\"\t\"\"\t\"D2 Dimmer 1\"\t\"DPST-1-1\"\t\"Auto\"",
		"\"'-1 =SUM(A1)\"\t\"1/0/2\"\t\"\"\t\"\"\t\"'@x\"\t\"DPST-5-1\"\t\"Auto\"",
	}, "\r\n") + "\r\n"
	if got != golden {
		t.Errorf("1/1:\n%q\nwant\n%q", got, golden)
	}
	got = string(groupAddressCSV(gs, FormatETS31))
	golden = "\ufeff" + strings.Join([]string{
		`"Main","Middle","Sub","Address","Central","Unfiltered","Description","DatapointType","Security"`,
		`"Ground floor","","","1/-/-","","","","","Auto"`,
		`"","Living","","1/0/-","","","","","Auto"`,
		`"","","Living ""Spots"" Switch","1/0/1","","","D2 Dimmer 1","DPST-1-1","Auto"`,
		`"","","'-1 =SUM(A1)","1/0/2","","","'@x","DPST-5-1","Auto"`,
	}, "\r\n") + "\r\n"
	if got != golden {
		t.Errorf("3/1:\n%q\nwant\n%q", got, golden)
	}
}
