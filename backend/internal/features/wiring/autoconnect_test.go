package wiring

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring/store"
)

// version builds a snapshot: a floorplan with zones of needs and a board
// with modules (variant ids map to capabilities).
type version struct {
	f     fixture
	data  plans.WiringData
	caps  map[uuid.UUID]capabilities.Capabilities
	conns []store.Connection
}

func newVersion(f fixture) *version {
	return &version{f: f, caps: map[uuid.UUID]capabilities.Capabilities{},
		data: plans.WiringData{Plans: []plans.WiringPlan{{ID: f.floor, Name: "Ground", Kind: "floorplan"}, {ID: f.board, Name: "Board", Kind: "board",
			Rows: []plans.WiringRow{{ID: uuid.New(), Position: 1, CapacityTE: 1000}}}}}}
}

func (v *version) zone(name string) uuid.UUID {
	id := uuid.New()
	v.data.Plans[0].Zones = append(v.data.Plans[0].Zones, plans.WiringZone{ID: id, Name: name})
	return id
}

func (v *version) need(zone uuid.UUID, ft uuid.UUID, qty int32, power string, lt *uuid.UUID) uuid.UUID {
	id := uuid.New()
	z := zone
	var p *string
	if power != "" {
		p = &power
	}
	v.data.Plans[0].Needs = append(v.data.Plans[0].Needs, plans.WiringNeed{ID: id, ZoneID: &z, FunctionTypeID: ft, Quantity: qty, PowerW: p, LoadTypeID: lt})
	return id
}

func (v *version) module(caps capabilities.Capabilities) uuid.UUID {
	id, variant := uuid.New(), uuid.New()
	v.caps[variant] = caps
	b := &v.data.Plans[1]
	b.Modules = append(b.Modules, plans.WiringItem{ID: id, VariantID: &variant, RowID: b.Rows[0].ID, OffsetTE: float64(len(b.Modules) * 4)})
	return id
}

func (v *version) snapshot() *snapshot {
	f := v.f
	fa := facts{cat: f.cat, caps: v.caps, variants: map[uuid.UUID]products.BOMVariant{}, types: map[uuid.UUID]producttypes.ProductType{},
		kinds: []capabilities.OutputKind{{ID: f.dimmer, Key: "dimmer_output"}, {ID: f.relay, Key: "relay_output"}, {ID: f.blind, Key: "blind_output"}}}
	sn := &snapshot{ref: projects.VersionRef{ID: uuid.New()}, data: v.data, conns: v.conns, facts: fa}
	sn.st = build(&sn.facts, sn.data, sn.conns)
	return sn
}

func TestAutoConnect(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	kitchen, living := v.zone("Kitchen"), v.zone("Living")
	n1 := v.need(kitchen, f.light, 3, "50", &f.led)    // circuit on one dimmer channel (150 W)
	n2 := v.need(kitchen, f.light, 2, "40", &f.led)    // joins the kitchen circuit until 200 W: 1 unit, then a new channel
	n3 := v.need(living, f.blindFn, 2, "", &f.acMotor) // two blind outputs from relay pairs
	n4 := v.need(living, f.socket, 1, "100", nil)      // a relay (pair 1+2 and 3+4 are taken by blinds → none left)
	v.need(living, uuid.New(), 1, "", nil)             // nothing serves it
	dim := v.module(f.dimmerCaps())
	rel := v.module(f.relayCaps())

	sn := v.snapshot()
	p, made := plan(sn, AutoConnectScope{Scope: "all"})
	got := []string{}
	for _, c := range p.Connections {
		item := "dim"
		if c.TargetItemID == rel {
			item = "rel"
		}
		got = append(got, fmt.Sprintf("%s:%d %s %s/%d", map[uuid.UUID]string{n1: "n1", n2: "n2", n3: "n3", n4: "n4"}[c.NeedID], c.Units, item,
			f.cat.KindKey[c.OutputKindID], c.ChannelNo))
	}
	want := []string{"n1:3 dim dimmer_output/1", "n2:1 dim dimmer_output/1", "n2:1 dim dimmer_output/2", "n3:1 rel blind_output/1", "n3:1 rel blind_output/2"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
	if len(made) != 5 || p.Units != 9 || p.ConnectedUnits != 7 || p.Needs != 5 {
		t.Fatalf("counts: %+v", p)
	}
	reasons := map[uuid.UUID]string{}
	for _, u := range p.Unconnectable {
		reasons[u.NeedID] = u.Reason
	}
	if reasons[n4] != ReasonNoFreeChannel || len(p.Unconnectable) != 2 {
		t.Fatalf("unconnectable: %+v", p.Unconnectable)
	}
	for _, u := range p.Unconnectable {
		if u.NeedID != n4 && u.Reason != ReasonNoChannelServes {
			t.Fatalf("reason %q", u.Reason)
		}
	}
	_ = dim

	// Same input, same output (and checksum).
	p2, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	if p2.Checksum != p.Checksum || len(p2.Connections) != len(p.Connections) {
		t.Fatal("not deterministic")
	}

	// A pinned connection is never moved: with n4 pinned to relay 1, blinds
	// only get the pair 3+4.
	v.conns = []store.Connection{{ID: uuid.New(), NeedPlanID: f.floor, NeedID: n4, Units: 1, TargetPlanID: f.board, TargetItemID: rel,
		OutputKindID: f.relay, ChannelNo: 1, Pinned: true, CreatedAt: time.Now()}}
	p3, made3 := plan(v.snapshot(), AutoConnectScope{Scope: "zones", ZoneIDs: []uuid.UUID{living}})
	if len(made3) != 1 || p3.Connections[0].ChannelNo != 2 || p3.Connections[0].OutputKindID != f.blind {
		t.Fatalf("with pinned: %+v", p3.Connections)
	}
	if p3.Checksum == p.Checksum {
		t.Fatal("checksum must change with the connections")
	}

	// Scope needs.
	p4, _ := plan(v.snapshot(), AutoConnectScope{Scope: "needs", NeedIDs: []uuid.UUID{n2}})
	if len(p4.Connections) != 1 || p4.Connections[0].Units != 2 || p4.Connections[0].NeedID != n2 {
		t.Fatalf("scope needs: %+v", p4.Connections)
	}
}

func TestAutoConnectRoomFirst(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	kitchen := v.zone("Kitchen")
	n := v.need(kitchen, f.light, 1, "20", &f.led)
	v.module(f.dimmerCaps())
	// An in-wall dimmer placed in the kitchen comes before the board.
	variant, inwall := uuid.New(), uuid.New()
	v.caps[variant] = f.dimmerCaps()
	v.data.Plans[0].Placements = []plans.WiringItem{{ID: inwall, VariantID: &variant, ZoneID: &kitchen}}
	p, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	if len(p.Connections) != 1 || p.Connections[0].TargetItemID != inwall || p.Connections[0].NeedID != n {
		t.Fatalf("got %+v", p.Connections)
	}
}

func TestAutoConnectLimits(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	z := v.zone("Hall")
	n := v.need(z, f.light, 1, "500", &f.led) // above every dimmer channel
	v.module(f.dimmerCaps())
	p, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	if len(p.Connections) != 0 || len(p.Unconnectable) != 1 || p.Unconnectable[0].Reason != ReasonLimitsExceeded || p.Unconnectable[0].NeedID != n {
		t.Fatalf("got %+v", p)
	}
}

// TestChecksSummaries covers zones, boards (alternatives), bus lines with
// reserve and defaults, gateways and routers.
func TestChecksSummaries(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	kitchen, living, empty := v.zone("Kitchen"), v.zone("Living"), v.zone("Empty")
	n1 := v.need(kitchen, f.light, 2, "50", &f.led)
	v.need(living, f.blindFn, 1, "", &f.acMotor)
	_ = empty
	dim := v.module(f.dimmerCaps())
	rel := v.module(f.relayCaps())
	v.conns = []store.Connection{
		{ID: uuid.New(), NeedPlanID: f.floor, NeedID: n1, Units: 2, TargetPlanID: f.board, TargetItemID: dim, OutputKindID: f.dimmer, ChannelNo: 1},
		// Dangling: the need is gone.
		{ID: uuid.New(), NeedPlanID: f.floor, NeedID: uuid.New(), Units: 1, TargetPlanID: f.board, TargetItemID: rel, OutputKindID: f.blind, ChannelNo: 1,
			AltBaseOutputKindID: &f.relay, AltGroup: ptr(int32(1))},
	}
	sn := v.snapshot()
	knx, zb := uuid.New(), uuid.New()
	sn.facts.types[knx] = producttypes.ProductType{ID: knx, ReservePercent: 20, BusDevicesMax: ptr(int32(4))}
	sn.facts.types[zb] = producttypes.ProductType{ID: zb, ReservePercent: 20}
	// Bus devices: the two modules (10 mA each, one by default), a PSU
	// supplying 30 mA → 20 / 30 = 67 % ok; plus one with unknown current.
	psu, unknown := uuid.New(), uuid.New()
	for _, it := range []struct {
		id   uuid.UUID
		caps capabilities.Capabilities
	}{{psu, capabilities.Capabilities{BusCurrentSuppliedMa: ptr(30.0)}}, {unknown, capabilities.Capabilities{}}} {
		sn.st.items[ItemKey{f.board, it.id}] = &Item{Key: ItemKey{f.board, it.id}, Board: true, HasVariant: true, Caps: it.caps}
	}
	sn.st.items[ItemKey{f.board, dim}].Caps.BusCurrentUsedMa = ptr(10.0)
	sn.st.items[ItemKey{f.board, rel}].Caps.BusCurrentUsedMa = ptr(10.0)
	sn.st.items[ItemKey{f.board, rel}].Caps.BusCurrentUsedMaDefault = true
	line := uuid.New()
	members := []networks.Member{}
	for _, id := range []uuid.UUID{dim, rel, psu, unknown} {
		l := line
		members = append(members, networks.Member{PlanID: f.board, ItemID: id, SystemID: knx, Topology: networks.TopologyBus, LineID: &l})
	}
	// A gateway with 21 devices, none a router, 25 places → amber.
	gw := uuid.New()
	sn.st.items[ItemKey{f.floor, gw}] = &Item{Key: ItemKey{f.floor, gw}, HasVariant: true, Caps: capabilities.Capabilities{WirelessPlacesSupplied: ptr(25.0)}}
	members = append(members, networks.Member{PlanID: f.floor, ItemID: gw, SystemID: zb, Topology: networks.TopologyWireless, Gateway: true})
	for i := 0; i < 21; i++ {
		id := uuid.New()
		sn.st.items[ItemKey{f.floor, id}] = &Item{Key: ItemKey{f.floor, id}, HasVariant: true, Caps: capabilities.Capabilities{WirelessPlacesUsed: ptr(1.0)}}
		gp, gi := f.floor, gw
		members = append(members, networks.Member{PlanID: f.floor, ItemID: id, SystemID: zb, Topology: networks.TopologyWireless, GatewayPlanID: &gp, GatewayItemID: &gi})
	}
	// A wireless device without gateway and a bus device without line.
	lost, noLine := uuid.New(), uuid.New()
	sn.st.items[ItemKey{f.floor, lost}] = &Item{Key: ItemKey{f.floor, lost}, HasVariant: true}
	sn.st.items[ItemKey{f.floor, noLine}] = &Item{Key: ItemKey{f.floor, noLine}, HasVariant: true}
	members = append(members, networks.Member{PlanID: f.floor, ItemID: lost, SystemID: zb, Topology: networks.TopologyWireless},
		networks.Member{PlanID: f.floor, ItemID: noLine, SystemID: knx, Topology: networks.TopologyBus})

	c := evaluateChecks(sn, members, []networks.BusLine{{ID: line, Name: "KNX 1", ProductTypeID: knx}})

	status := map[string]string{}
	for _, z := range c.Zones {
		status[z.Name] = z.Status
	}
	if status["Kitchen"] != "covered" || status["Living"] != "missing" || status["Empty"] != "none" || c.Counts.ZonesCovered != 1 || c.Counts.ZonesWithNeeds != 2 {
		t.Fatalf("zones %+v", c.Zones)
	}
	if len(c.Boards) != 1 {
		t.Fatalf("boards %+v", c.Boards)
	}
	uses := map[string]ChannelUse{}
	for _, u := range c.Boards[0].Channels {
		uses[u.OutputKindKey] = u
	}
	// The dangling connection on blind 1 still occupies relays 1+2.
	if d := uses["dimmer_output"]; d.Total != 4 || d.Used != 1 || d.Free != 3 {
		t.Fatalf("dimmer %+v", d)
	}
	if r := uses["relay_output"]; r.Total != 4 || r.Used != 2 || r.Free != 2 {
		t.Fatalf("relay %+v", r)
	}
	if b := uses["blind_output"]; !b.Alternative || b.Total != 2 || b.Used != 1 || b.Free != 1 {
		t.Fatalf("blind %+v", b)
	}
	l := c.BusLines[0]
	if l.CurrentUsedMa != 20 || l.CurrentDefaultMa != 10 || l.CurrentSuppliedMa != 30 || l.UnknownCurrentCount != 1 || l.CurrentStatus != StatusOK ||
		l.Devices != 4 || l.DevicesStatus != StatusAmber {
		t.Fatalf("line %+v", l)
	}
	g := c.Gateways[0]
	if g.Devices != 21 || g.PlacesUsed != 21 || g.Status != StatusAmber {
		t.Fatalf("gateway %+v", g)
	}
	found := map[string]int{}
	for _, fd := range c.Findings {
		found[fd.Code]++
	}
	for code, n := range map[string]int{CodeNeedNotFound: 1, CodeNeedUnconnected: 1, CodeBusCurrentUnknown: 1, CodeBusLineDevicesHigh: 1,
		CodeGatewayPlacesHigh: 1, CodeGatewayNoRouter: 1, CodeWirelessNoGateway: 1, CodeBusDeviceUnassigned: 1} {
		if found[code] != n {
			t.Fatalf("finding %s: %d, want %d (%v)", code, found[code], n, found)
		}
	}
	if c.Findings[0].Severity != SeverityError {
		t.Fatal("errors first")
	}

	// The supply drops to 20 mA: exceeded (red) → error; without supply →
	// no power supply.
	sn.st.items[ItemKey{f.board, psu}].Caps.BusCurrentSuppliedMa = ptr(19.0)
	c = evaluateChecks(sn, members, []networks.BusLine{{ID: line, Name: "KNX 1", ProductTypeID: knx}})
	if c.BusLines[0].CurrentStatus != StatusRed {
		t.Fatalf("line %+v", c.BusLines[0])
	}
	sn.st.items[ItemKey{f.board, psu}].Caps.BusCurrentSuppliedMa = nil
	c = evaluateChecks(sn, members, []networks.BusLine{{ID: line, Name: "KNX 1", ProductTypeID: knx}})
	if c.BusLines[0].CurrentStatus != StatusUnknown || !slices.ContainsFunc(c.Findings, func(f Finding) bool { return f.Code == CodeBusLineNoPowerSupply }) {
		t.Fatalf("no supply %+v", c.BusLines[0])
	}
}

// TestPerformance: about 2000 needs on a large board, auto-connect and the
// checks stay fast and deterministic.
func TestPerformance(t *testing.T) {
	f := newFixture()
	v := newVersion(f)
	for z := 0; z < 200; z++ {
		zone := v.zone(fmt.Sprintf("Room %d", z))
		for i := 0; i < 10; i++ {
			switch i % 3 {
			case 0:
				v.need(zone, f.light, 2, "20", &f.led)
			case 1:
				v.need(zone, f.socket, 1, "100", nil)
			default:
				v.need(zone, f.blindFn, 1, "", &f.acMotor)
			}
		}
	}
	for m := 0; m < 300; m++ {
		v.module(f.dimmerCaps())
		v.module(f.relayCaps())
	}
	start := time.Now()
	sn := v.snapshot()
	p, made := plan(sn, AutoConnectScope{Scope: "all"})
	if time.Since(start) > 3*time.Second {
		t.Fatalf("auto-connect took %v", time.Since(start))
	}
	if len(made) == 0 || p.ConnectedUnits == 0 {
		t.Fatal("nothing connected")
	}
	// Apply the plan as stored connections and evaluate.
	for _, c := range made {
		base, group := altOf(c.Channel)
		v.conns = append(v.conns, store.Connection{ID: c.ID, NeedPlanID: c.Need.PlanID, NeedID: c.Need.ID, Units: c.Units, TargetPlanID: c.Channel.Item.PlanID,
			TargetItemID: c.Channel.Item.ID, OutputKindID: c.Channel.Kind, ChannelNo: int32(c.Channel.No), AltBaseOutputKindID: base, AltGroup: group})
	}
	start = time.Now()
	c := evaluateChecks(v.snapshot(), nil, nil)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("checks took %v", time.Since(start))
	}
	for _, fd := range c.Findings {
		if fd.Severity == SeverityError {
			t.Fatalf("auto-connect made an invalid connection: %+v", fd)
		}
	}
	p2, _ := plan(v.snapshot(), AutoConnectScope{Scope: "all"})
	if len(p2.Connections) != 0 {
		t.Fatalf("a second run found more: %d", len(p2.Connections))
	}
	t.Logf("needs 2000, units %d, connected %d, unconnectable %d", p.Units, p.ConnectedUnits, len(p.Unconnectable))
}
