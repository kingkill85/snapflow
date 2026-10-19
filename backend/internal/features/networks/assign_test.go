package networks

import (
	"strconv"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/networks/store"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
)

// HDL: two lines (subnet 3 from the address field, the second by default
// 1, the first subnet free), a floorplan before the board: board modules are numbered first; a
// pinned 3.1 is skipped; a power supply gets none; device 1 of subnet 1.
func TestAssignHDL(t *testing.T) {
	hdl := producttypes.ProductType{ID: uuid.New(), Key: "hdl", Topology: TopologyBus, Addressing: producttypes.AddressingHDL}
	dev, psu := uuid.New(), uuid.New()
	supplied := 100.0
	floor, board := uuid.New(), uuid.New()
	f1, b1, b2, b3, b4 := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	line1, line2 := uuid.New(), uuid.New()
	st := state{
		ref: projects.VersionRef{ID: uuid.New()},
		plans: []plans.NetworkPlan{
			{ID: floor, Kind: "floorplan", Items: []plans.NetworkItem{{ID: f1, VariantID: &dev}}},
			{ID: board, Kind: "board", Items: []plans.NetworkItem{{ID: b1, VariantID: &dev}, {ID: b2, VariantID: &psu}, {ID: b3, VariantID: &dev},
				{ID: b4, VariantID: &dev}}},
		},
		lines: []store.BusLine{{ID: line1, ProductTypeID: hdl.ID, Name: "A", Address: "3"}, {ID: line2, ProductTypeID: hdl.ID, Name: "B"}},
		assignments: map[[2]uuid.UUID]store.NetworkAssignment{
			{board, b4}: {PlanID: board, ItemID: b4, BusLineID: &line2},
		},
		variants: map[uuid.UUID]products.BOMVariant{dev: {ID: dev, ProductType: hdl}, psu: {ID: psu, ProductType: hdl}},
		caps:     map[uuid.UUID]capabilities.Capabilities{psu: {BusCurrentSuppliedMa: &supplied}},
		types:    map[uuid.UUID]producttypes.ProductType{hdl.ID: hdl},
	}
	sn, d := int16(3), int16(1)
	st.addresses = map[[2]uuid.UUID]store.DeviceAddress{{board, b3}: {PlanID: board, ItemID: b3, HdlSubnet: &sn, HdlDevice: &d, Pinned: true}}
	rows, assigned, unassigned := st.assign(nil)
	if assigned != 3 || unassigned != 0 {
		t.Fatalf("assigned %d unassigned %d", assigned, unassigned)
	}
	got := map[uuid.UUID]string{}
	for _, r := range rows {
		got[r.row.ItemID] = addressOf(r.row).HDL
	}
	if got[b1] != "3.2" || got[f1] != "3.3" || got[b4] != "1.1" || got[b2] != "" || got[b3] != "" {
		t.Errorf("addresses %v", got)
	}
	// Issues: none duplicated, b3 inside its line; no missing (all set).
	st.addresses[[2]uuid.UUID{board, b1}] = rows[0].row
	for _, is := range st.addressIssues() {
		if is.Code == "address_duplicate" || is.Code == "address_outside_line" {
			t.Errorf("issue %+v", is)
		}
	}
}

// A pinned row without an address (a note only, as rows written before
// the pinned rule) counts as automatic: the device gets a number.
func TestAssignPinnedWithoutAddress(t *testing.T) {
	knx := producttypes.ProductType{ID: uuid.New(), Key: "knx", Topology: TopologyBus, Addressing: producttypes.AddressingKNX}
	dev := uuid.New()
	board, m1 := uuid.New(), uuid.New()
	line := uuid.New()
	st := state{
		ref:         projects.VersionRef{ID: uuid.New()},
		plans:       []plans.NetworkPlan{{ID: board, Kind: "board", Items: []plans.NetworkItem{{ID: m1, VariantID: &dev}}}},
		lines:       []store.BusLine{{ID: line, ProductTypeID: knx.ID, Name: "A"}},
		assignments: map[[2]uuid.UUID]store.NetworkAssignment{},
		variants:    map[uuid.UUID]products.BOMVariant{dev: {ID: dev, ProductType: knx}},
		caps:        map[uuid.UUID]capabilities.Capabilities{},
		types:       map[uuid.UUID]producttypes.ProductType{knx.ID: knx},
		addresses:   map[[2]uuid.UUID]store.DeviceAddress{{board, m1}: {PlanID: board, ItemID: m1, Note: "n", Pinned: true}},
	}
	rows, assigned, _ := st.assign(nil)
	if assigned != 1 || len(rows) != 1 || addressOf(rows[0].row).KNX != "1.1.1" || rows[0].row.Note != "n" || rows[0].row.Pinned {
		t.Fatalf("rows %+v assigned %d", rows, assigned)
	}
}

// Defaults skip the prefixes of address fields; when none is free the line
// has no prefix and its devices stay without address.
func TestDefaultPrefixes(t *testing.T) {
	knx := producttypes.ProductType{ID: uuid.New(), Key: "knx", Topology: TopologyBus, Addressing: producttypes.AddressingKNX}
	st := state{types: map[uuid.UUID]producttypes.ProductType{knx.ID: knx}}
	// Lines 1.1 … 1.15 by address field, then one without.
	for n := 1; n <= 15; n++ {
		st.lines = append(st.lines, store.BusLine{ID: uuid.New(), ProductTypeID: knx.ID, Address: "1." + strconv.Itoa(n)})
	}
	st.lines = append(st.lines, store.BusLine{ID: uuid.New(), ProductTypeID: knx.ID})
	infos := st.lineInfos()
	last := infos[len(infos)-1]
	if !last.noPrefix || last.usable() || last.prefixString() != "" {
		t.Errorf("full: %+v", last)
	}
	// Free one up: the line without address takes it.
	st.lines[4].Address = "2.1"
	if li := st.lineInfos()[15]; li.noPrefix || li.prefixString() != "1.5" {
		t.Errorf("free: %+v", li)
	}
	if issues := st.addressIssues(); len(issues) != 0 {
		t.Errorf("issues %+v", issues)
	}
}

func TestLinePrefix(t *testing.T) {
	for _, c := range []struct {
		scheme, addr string
		set, ok      bool
	}{
		{SchemeKNX, "1.2", true, true}, {SchemeKNX, "1/2", false, false}, {SchemeHDL, "0", true, false}, {SchemeKNX, "16.1", true, false}, {SchemeKNX, "x", false, false},
		{SchemeKNX, "", false, true}, {SchemeHDL, "254", true, true}, {SchemeHDL, "255", true, false}, {SchemeHDL, "1.2", false, false},
		{SchemeNone, "anything", false, true},
	} {
		if _, set, ok := parseLinePrefix(c.scheme, c.addr); set != c.set || ok != c.ok {
			t.Errorf("%s %q: %v %v", c.scheme, c.addr, set, ok)
		}
	}
}
