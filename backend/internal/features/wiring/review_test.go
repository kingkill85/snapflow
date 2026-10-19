package wiring

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring/store"
)

// plannedOn maps each need to "item:kind/no" of its planned connections.
func plannedOn(p AutoConnectPreview, names map[uuid.UUID]string, kinds map[uuid.UUID]string) map[uuid.UUID][]string {
	out := map[uuid.UUID][]string{}
	for _, c := range p.Connections {
		out[c.NeedID] = append(out[c.NeedID], fmt.Sprintf("%s:%s/%d", names[c.TargetItemID], kinds[c.OutputKindID], c.ChannelNo))
	}
	return out
}

// TestAutoConnectKeepsPairsForBlinds (D409): M1 has 4 relays usable as
// blind outputs, M2 4 plain relays. Three relay needs and one blind: the
// blind gets a pair of M1, the relays go to M2.
func TestAutoConnectKeepsPairsForBlinds(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	var sockets []uuid.UUID
	for i := 0; i < 3; i++ {
		sockets = append(sockets, v.need(v.zone(fmt.Sprintf("Room %d", i)), f.socket, 1, "100", nil))
	}
	blind := v.need(v.zone("Bedroom"), f.blindFn, 1, "", &f.acMotor)
	m1 := v.module(f.relayCaps())
	plain := f.relayCaps()
	plain.Channels[0].Alternatives = nil
	m2 := v.module(plain)
	p, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	on := plannedOn(p, map[uuid.UUID]string{m1: "M1", m2: "M2"}, f.cat.KindKey)
	if len(p.Unconnectable) != 0 || fmt.Sprint(on[blind]) != "[M1:blind_output/1]" {
		t.Fatalf("blind %v, unconnectable %+v", on[blind], p.Unconnectable)
	}
	for i, s := range sockets {
		if want := fmt.Sprintf("[M2:relay_output/%d]", i+1); fmt.Sprint(on[s]) != want {
			t.Fatalf("socket %d on %v, want %s", i, on[s], want)
		}
	}
	// Listed in need order (sockets first, as in the plan).
	if p.Connections[0].NeedID != sockets[0] || p.Connections[3].NeedID != blind {
		t.Fatalf("order %+v", p.Connections)
	}
}

// TestAutoConnectPrefersSpecificKinds (D409): a light takes a dimmer (a
// kind serving fewer function types) before an earlier relay module; a
// blind takes native blind outputs before relay pairs.
func TestAutoConnectPrefersSpecificKinds(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	light := v.need(v.zone("Hall"), f.light, 1, "20", &f.led)
	blind := v.need(v.zone("Bedroom"), f.blindFn, 1, "", &f.acMotor)
	rel := v.module(f.relayCaps())
	dim := v.module(f.dimmerCaps())
	native := v.module(capabilities.Capabilities{MotorType: "ac", Channels: []capabilities.ChannelCapability{{OutputKindID: f.blind, Count: 2}}})
	p, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	on := plannedOn(p, map[uuid.UUID]string{rel: "rel", dim: "dim", native: "blind"}, f.cat.KindKey)
	if fmt.Sprint(on[light]) != "[dim:dimmer_output/1]" || fmt.Sprint(on[blind]) != "[blind:blind_output/1]" {
		t.Fatalf("light %v, blind %v", on[light], on[blind])
	}
}

// TestAutoConnectRepair (D409): a connection of this run that alone blocks
// a channel is moved when the unit fits nowhere else. The light (100 W
// halogen) only fits the dimmer at 300 W halogen; a 150 W LED light came
// first in its zone and took it although the relay serves it too.
func TestAutoConnectRepair(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	z := v.zone("Hall")
	led := v.need(z, f.light, 1, "150", &f.led)
	halo := v.need(v.zone("Study"), f.light, 1, "250", &f.halogen)
	dimCaps := f.dimmerCaps()
	dimCaps.Channels[0].Count = 1
	dim := v.module(dimCaps)
	relCaps := f.relayCaps()
	relCaps.Channels[0].Count = 1
	relCaps.Channels[0].Alternatives = nil
	relCaps.Channels[0].LimitsW = []capabilities.Limit{lim(&f.led, 200)} // no halogen limit → warning only
	relCaps.Channels[0].LimitsA = nil
	relCaps.Channels[0].LimitsW = append(relCaps.Channels[0].LimitsW, lim(&f.halogen, 100)) // halogen 250 W does not fit
	rel := v.module(relCaps)
	p, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	on := plannedOn(p, map[uuid.UUID]string{dim: "dim", rel: "rel"}, f.cat.KindKey)
	if len(p.Unconnectable) != 0 || fmt.Sprint(on[halo]) != "[dim:dimmer_output/1]" || fmt.Sprint(on[led]) != "[rel:relay_output/1]" {
		t.Fatalf("halo %v, led %v, unconnectable %+v", on[halo], on[led], p.Unconnectable)
	}
}

// TestAutoConnectFastWhenChannelsRunOut (D415): 2000 lights, far more than
// the dimmer channels take, stay well under 200 ms.
func TestAutoConnectFastWhenChannelsRunOut(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	for z := 0; z < 200; z++ {
		zone := v.zone(fmt.Sprintf("Room %d", z))
		for i := 0; i < 10; i++ {
			v.need(zone, f.light, 1, "150", &f.led) // one per dimmer channel (200 W)
		}
	}
	for m := 0; m < 100; m++ {
		v.module(f.dimmerCaps())
	}
	sn := v.snapshot()
	start := time.Now()
	p, _ := plan(sn, AutoConnectScope{Scope: "all"})
	if d := time.Since(start); d > 200*time.Millisecond {
		t.Fatalf("auto-connect took %v", d)
	}
	if p.ConnectedUnits != 400 || len(p.Unconnectable) != 1600 {
		t.Fatalf("connected %d, unconnectable %d", p.ConnectedUnits, len(p.Unconnectable))
	}
}

// TestAlternativeIdentity (D410): a connection to an alternative channel
// keeps its base channels when the product gains native channels of the
// kind; only its display number changes.
func TestAlternativeIdentity(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	n := v.need(v.zone("Bedroom"), f.blindFn, 1, "", &f.acMotor)
	mod := v.module(f.relayCaps())
	v.conns = []store.Connection{{ID: uuid.New(), NeedPlanID: f.floor, NeedID: n, Units: 1, TargetPlanID: f.board, TargetItemID: mod,
		OutputKindID: f.blind, ChannelNo: 1, AltBaseOutputKindID: &f.relay, AltGroup: ptr(int32(1))}}
	sn := v.snapshot()
	if got := connectionOut(v.conns[0], sn.st).ChannelNo; got != 1 {
		t.Fatalf("number %d", got)
	}
	// The catalog now gives the product 2 native blind outputs.
	for variant, caps := range v.caps {
		caps.Channels = append([]capabilities.ChannelCapability{{OutputKindID: f.blind, Count: 2}}, caps.Channels...)
		v.caps[variant] = caps
	}
	sn = v.snapshot()
	c := sn.st.conns[0]
	sl, ok := sn.st.slot(c.Channel)
	if !ok || sl.cap.OutputKindID != f.relay || sl.first != 1 || sl.last != 2 {
		t.Fatalf("slot %+v", sl)
	}
	if got := connectionOut(v.conns[0], sn.st).ChannelNo; got != 3 {
		t.Fatalf("number %d, want 3 (after the 2 native ones)", got)
	}
	if len(sn.st.evaluate()) != 1 { // power_unknown only (relays have an A limit)
		t.Fatalf("problems %+v", sn.st.evaluate())
	}
	// A native channel 1 stays native.
	if k := sn.st.keyOf(c.Channel.Item, f.blind, 1); k.Alternative() {
		t.Fatalf("key %+v", k)
	}
}

func TestStatusOf(t *testing.T) {
	for _, tc := range []struct {
		used, supplied float64
		reserve        int32
		want           Status
	}{
		{80, 100, 20, StatusOK}, {80.01, 100, 20, StatusAmber}, {100, 100, 20, StatusAmber}, {100.01, 100, 20, StatusRed},
		{100, 100, 0, StatusOK}, {100.01, 100, 0, StatusRed}, {0, 100, 100, StatusOK}, {0.01, 100, 100, StatusAmber},
		{1, 0, 20, StatusUnknown},
	} {
		if got := statusOf(tc.used, tc.supplied, tc.reserve); got != tc.want {
			t.Errorf("statusOf(%v, %v, %d) = %s, want %s", tc.used, tc.supplied, tc.reserve, got, tc.want)
		}
	}
}

// gatewayChecks evaluates a gateway with devices, routers of them routers.
func gatewayChecks(devices, routers int) Checks {
	f := newFixture()
	v := newVersion(f)
	sn := v.snapshot()
	zb := uuid.New()
	sn.facts.types[zb] = producttypes.ProductType{ID: zb, ReservePercent: 20}
	gw := uuid.New()
	sn.st.items[ItemKey{f.floor, gw}] = &Item{Key: ItemKey{f.floor, gw}, HasVariant: true, Label: "GW1",
		Caps: capabilities.Capabilities{WirelessPlacesSupplied: ptr(100.0)}}
	members := []networks.Member{{PlanID: f.floor, ItemID: gw, SystemID: zb, Topology: networks.TopologyWireless, Gateway: true}}
	for i := 0; i < devices; i++ {
		id := uuid.New()
		sn.st.items[ItemKey{f.floor, id}] = &Item{Key: ItemKey{f.floor, id}, HasVariant: true,
			Caps: capabilities.Capabilities{WirelessPlacesUsed: ptr(1.0), ZigbeeRouter: ptr(i < routers)}}
		gp, gi := f.floor, gw
		members = append(members, networks.Member{PlanID: f.floor, ItemID: id, SystemID: zb, Topology: networks.TopologyWireless,
			GatewayPlanID: &gp, GatewayItemID: &gi})
	}
	return evaluateChecks(sn, members, nil)
}

func has(c Checks, code string) *Finding {
	for i := range c.Findings {
		if c.Findings[i].Code == code {
			return &c.Findings[i]
		}
	}
	return nil
}

func TestRouterThreshold(t *testing.T) {
	if has(gatewayChecks(19, 0), CodeGatewayNoRouter) != nil {
		t.Fatal("19 devices: no warning")
	}
	fd := has(gatewayChecks(20, 0), CodeGatewayNoRouter)
	if fd == nil || fd.Params["label"] != "GW1" {
		t.Fatalf("20 devices: warning with the label, got %+v", fd)
	}
	if has(gatewayChecks(21, 1), CodeGatewayNoRouter) != nil {
		t.Fatal("one router: no warning")
	}
}

// TestChecksReview: rows on their own, zones count only connections
// without errors, dangling assignments, names of items without channels,
// a need of a removed zone links to its plan.
func TestChecksReview(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	kitchen := v.zone("Kitchen")
	ok := v.need(kitchen, f.light, 1, "20", &f.led)
	bad := v.need(kitchen, f.blindFn, 1, "", &f.acMotor)
	gone := uuid.New()
	v.data.Plans[0].Needs = append(v.data.Plans[0].Needs, v.data.Plans[0].Needs[0])
	v.data.Plans[0].Needs[2].ID, v.data.Plans[0].Needs[2].ZoneID = uuid.New(), &gone
	dim := v.module(f.dimmerCaps())
	// Two rows: the second over its own capacity although the board total fits.
	b := &v.data.Plans[1]
	b.Rows[0].CapacityTE = 10
	b.Rows = append(b.Rows, b.Rows[0])
	b.Rows[1].ID, b.Rows[1].Position, b.Rows[1].CapacityTE = uuid.New(), 2, 0.5
	b.Modules[0].RowID = b.Rows[1].ID
	v.conns = []store.Connection{
		{ID: uuid.New(), NeedPlanID: f.floor, NeedID: ok, Units: 1, TargetPlanID: f.board, TargetItemID: dim, OutputKindID: f.dimmer, ChannelNo: 1},
		{ID: uuid.New(), NeedPlanID: f.floor, NeedID: bad, Units: 1, TargetPlanID: f.board, TargetItemID: dim, OutputKindID: f.dimmer, ChannelNo: 2},
	}
	sn := v.snapshot()
	knx := uuid.New()
	sn.facts.types[knx] = producttypes.ProductType{ID: knx, ReservePercent: 20}
	sensor := uuid.New()
	sn.st.items[ItemKey{f.floor, sensor}] = &Item{Key: ItemKey{f.floor, sensor}, HasVariant: true, Label: "S1"}
	members := []networks.Member{{PlanID: f.floor, ItemID: sensor, SystemID: knx, Topology: networks.TopologyBus, Dangling: "bus_line"}}
	c := evaluateChecks(sn, members, nil)

	if z := c.Zones[0]; z.Status != "partial" || z.ConnectedUnits != 1 || z.Units != 2 {
		t.Fatalf("kitchen %+v (the blind on a dimmer has an error)", z)
	}
	if r := c.Boards[0].Rows; len(r) != 2 || r[1].Status != StatusRed || r[0].Status != StatusOK {
		t.Fatalf("rows %+v", r)
	}
	if fd := has(c, CodeBoardRowOverCapacity); fd == nil || fd.Params["row"] != 2 || fd.Params["name"] != "Board" {
		t.Fatalf("row finding %+v", fd)
	}
	if fd := has(c, CodeAssignmentDangling); fd == nil || fd.Params["kind"] != "bus_line" || fd.Params["label"] != "S1" {
		t.Fatalf("dangling %+v", fd)
	}
	if fd := has(c, CodeBusDeviceUnassigned); fd == nil || fd.Params["label"] != "S1" {
		t.Fatalf("unassigned %+v", fd)
	}
	for _, fd := range c.Findings {
		if fd.Code == CodeNeedUnconnected && fd.Refs.NeedID != nil && *fd.Refs.NeedID == v.data.Plans[0].Needs[2].ID && fd.Refs.ZoneID != nil {
			t.Fatalf("a need of a removed zone links to its plan: %+v", fd.Refs)
		}
	}
}
