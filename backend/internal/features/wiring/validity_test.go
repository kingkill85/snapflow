package wiring

import (
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
)

// fixture is a small catalog: dimmer, relay and blind kinds (blind from 2
// relays), function types light (circuit), socket (circuit), blind, and
// load types led, halogen, ac_motor, dc_motor.
type fixture struct {
	cat                                  Catalog
	dimmer, relay, blind                 uuid.UUID
	light, socket, blindFn               uuid.UUID
	led, halogen, acMotor, dcMotor       uuid.UUID
	board                                uuid.UUID
	floor                                uuid.UUID
}

func newFixture() fixture {
	f := fixture{dimmer: uuid.New(), relay: uuid.New(), blind: uuid.New(), light: uuid.New(), socket: uuid.New(), blindFn: uuid.New(),
		led: uuid.New(), halogen: uuid.New(), acMotor: uuid.New(), dcMotor: uuid.New(), board: uuid.New(), floor: uuid.New()}
	f.cat = Catalog{
		Served: map[uuid.UUID]map[uuid.UUID]bool{
			f.dimmer: {f.light: true},
			f.relay:  {f.light: true, f.socket: true},
			f.blind:  {f.blindFn: true},
		},
		KindOrder:   map[uuid.UUID]int{f.dimmer: 0, f.relay: 1, f.blind: 2},
		KindKey:     map[uuid.UUID]string{f.dimmer: "dimmer_output", f.relay: "relay_output", f.blind: "blind_output"},
		Circuit:     map[uuid.UUID]bool{f.light: true, f.socket: true},
		FunctionKey: map[uuid.UUID]string{f.light: "light", f.socket: "socket", f.blindFn: "blind"},
		LoadTypeKey: map[uuid.UUID]string{f.led: "led", f.halogen: "halogen", f.acMotor: "ac_motor", f.dcMotor: "dc_motor"},
	}
	return f
}

func ptr[T any](v T) *T { return &v }

func lim(lt *uuid.UUID, v float64) capabilities.Limit { return capabilities.Limit{LoadTypeID: lt, Value: v} }

// dimmerCaps: 4 dimmer channels, 200 W LED / 300 W halogen, min 5 W.
func (f fixture) dimmerCaps() capabilities.Capabilities {
	return capabilities.Capabilities{Channels: []capabilities.ChannelCapability{{OutputKindID: f.dimmer, Count: 4,
		LimitsW:   []capabilities.Limit{lim(&f.led, 200), lim(&f.halogen, 300)},
		MinLoadsW: []capabilities.Limit{lim(nil, 5)}}}}
}

// relayCaps: 4 relay channels, usable as 2 blind channels, 10 A each, AC
// motors.
func (f fixture) relayCaps() capabilities.Capabilities {
	return capabilities.Capabilities{MotorType: "ac", Channels: []capabilities.ChannelCapability{{OutputKindID: f.relay, Count: 4,
		LimitsA:      []capabilities.Limit{lim(nil, 10)},
		Alternatives: []capabilities.ChannelAlternative{{OutputKindID: f.blind, Per: 2, Max: 2}}}}}
}

type tcase struct {
	name  string
	needs []*Need
	items []*Item
	conns []*Conn
	// want: codes expected (in any order); none = valid.
	want []string
}

func (f fixture) need(id int, ft uuid.UUID, qty int32, powerW *float64, lt *uuid.UUID) *Need {
	n := &Need{Key: NeedKey{f.floor, uuid.NewSHA1(uuid.Nil, []byte{byte(id)})}, FunctionTypeID: ft, Quantity: qty, LoadTypeID: lt}
	if powerW != nil {
		v := int64(*powerW * 100)
		n.PowerCW = &v
	}
	return n
}

func (f fixture) item(id int, caps capabilities.Capabilities) *Item {
	return &Item{Key: ItemKey{f.board, uuid.NewSHA1(uuid.Nil, []byte{100 + byte(id)})}, Board: true, HasVariant: true, Caps: caps, Voltage: 230}
}

func conn(n *Need, it *Item, kind uuid.UUID, no int, units int32) *Conn {
	return &Conn{ID: uuid.New(), Need: n.Key, Units: units, Channel: ChannelKey{Item: it.Key, Kind: kind, No: no}}
}

func codes(ps []Problem) []string {
	out := []string{}
	for _, p := range ps {
		out = append(out, p.Code)
	}
	slices.Sort(out)
	return out
}

func TestValidity(t *testing.T) {
	f := newFixture()
	w := func(v float64) *float64 { return &v }
	dim := f.item(1, f.dimmerCaps())
	rel := f.item(2, f.relayCaps())
	totals := f.dimmerCaps()
	totals.ModuleTotalsW = []capabilities.Limit{lim(nil, 250)}
	totals.ModuleTotalA = ptr(1.0)
	dimTotals := f.item(3, totals)
	noVariant := f.item(4, capabilities.Capabilities{})
	noVariant.HasVariant = false

	ledA := f.need(1, f.light, 3, w(50), &f.led)
	ledB := f.need(2, f.light, 2, w(60), &f.led)
	halo := f.need(3, f.light, 1, w(250), &f.halogen)
	socket := f.need(4, f.socket, 1, w(100), nil)
	blindAC := f.need(5, f.blindFn, 2, nil, &f.acMotor)
	blindDC := f.need(6, f.blindFn, 1, nil, &f.dcMotor)
	unknownLT := f.need(7, f.light, 1, w(10), nil)
	tiny := f.need(8, f.light, 1, w(2), &f.led)
	heavy := f.need(9, f.light, 1, w(2400), nil)
	unknownPower := f.need(10, f.light, 1, nil, &f.led)
	allNeeds := []*Need{ledA, ledB, halo, socket, blindAC, blindDC, unknownLT, tiny, heavy, unknownPower}
	allItems := []*Item{dim, rel, dimTotals, noVariant}

	cases := []tcase{
		{name: "valid circuit of one need", conns: []*Conn{conn(ledA, dim, f.dimmer, 1, 3)}},
		{name: "output kind does not serve the function type", conns: []*Conn{conn(blindAC, dim, f.dimmer, 1, 1)}, want: []string{CodeFunctionNotServed}},
		{name: "channel number out of range", conns: []*Conn{conn(ledA, dim, f.dimmer, 5, 1)}, want: []string{CodeChannelNotFound}},
		{name: "kind not on the item", conns: []*Conn{conn(ledA, dim, f.relay, 1, 1)}, want: []string{CodeChannelNotFound}},
		{name: "item without variant", conns: []*Conn{conn(ledA, noVariant, f.dimmer, 1, 1)}, want: []string{CodeChannelNotFound}},
		{name: "target gone", conns: []*Conn{{ID: uuid.New(), Need: ledA.Key, Units: 1, Channel: ChannelKey{Item: ItemKey{f.board, uuid.New()}, Kind: f.dimmer, No: 1}}},
			want: []string{CodeTargetNotFound}},
		{name: "need gone", conns: []*Conn{{ID: uuid.New(), Need: NeedKey{f.floor, uuid.New()}, Units: 1, Channel: ChannelKey{Item: dim.Key, Kind: f.dimmer, No: 1}}},
			want: []string{CodeNeedNotFound}},
		{name: "circuit of two needs of a circuit function type", conns: []*Conn{conn(ledA, dim, f.dimmer, 1, 1), conn(ledB, dim, f.dimmer, 1, 1)}},
		{name: "circuit across function types refused", conns: []*Conn{conn(ledA, rel, f.relay, 1, 1), conn(socket, rel, f.relay, 1, 1)},
			want: []string{CodeCircuitNotAllowed}},
		{name: "blind: one unit per channel", conns: []*Conn{conn(blindAC, rel, f.blind, 1, 2)}, want: []string{CodeCircuitNotAllowed}},
		{name: "units above quantity", conns: []*Conn{conn(ledB, dim, f.dimmer, 1, 1), conn(ledB, dim, f.dimmer, 2, 2)}, want: []string{CodeUnitsExceeded}},
		{name: "W limit per load type exceeded", conns: []*Conn{conn(ledA, dim, f.dimmer, 1, 3), conn(ledB, dim, f.dimmer, 1, 1)},
			want: []string{CodeChannelOverloadW}}, // 150 + 60 > 200
		{name: "W limit of the load type", conns: []*Conn{conn(halo, dim, f.dimmer, 1, 1)}}, // 250 <= 300 halogen
		{name: "mixed load types take the strictest limit", conns: []*Conn{conn(halo, dim, f.dimmer, 1, 1), conn(tiny, dim, f.dimmer, 1, 1)},
			want: []string{CodeChannelOverloadW}}, // 252 > min(200, 300)
		{name: "no limit for the load type is a warning", conns: []*Conn{conn(unknownLT, dim, f.dimmer, 1, 1)}, want: []string{CodeLimitUnknown}},
		{name: "minimum load not reached is a warning", conns: []*Conn{conn(tiny, dim, f.dimmer, 1, 1)}, want: []string{CodeMinLoad}},
		{name: "minimum load not judged with unknown power", conns: []*Conn{conn(unknownPower, dim, f.dimmer, 1, 1)}},
		{name: "A limit via the nominal voltage", conns: []*Conn{conn(heavy, rel, f.relay, 1, 1)}, want: []string{CodeChannelOverloadA}}, // 2400/230 > 10
		{name: "module total W", conns: []*Conn{conn(ledA, dimTotals, f.dimmer, 1, 3), conn(ledB, dimTotals, f.dimmer, 2, 2)},
			want: []string{CodeModuleOverloadA, CodeModuleOverloadW}}, // 270 W > 250; 1.17 A > 1
		{name: "motor type matches", conns: []*Conn{conn(blindAC, rel, f.blind, 1, 1)}},
		{name: "motor type mismatch", conns: []*Conn{conn(blindDC, rel, f.blind, 1, 1)}, want: []string{CodeMotorMismatch}},
		{name: "alternative and base on the same pair", conns: []*Conn{conn(blindAC, rel, f.blind, 1, 1), conn(socket, rel, f.relay, 2, 1)},
			want: []string{CodeChannelConflict, CodeChannelConflict}},
		{name: "alternative and base on different pairs", conns: []*Conn{conn(blindAC, rel, f.blind, 1, 1), conn(socket, rel, f.relay, 3, 1)}},
		{name: "second alternative channel uses relays 3 and 4", conns: []*Conn{conn(blindAC, rel, f.blind, 2, 1), conn(socket, rel, f.relay, 4, 1)},
			want: []string{CodeChannelConflict, CodeChannelConflict}},
		{name: "alternative channel out of range", conns: []*Conn{conn(blindAC, rel, f.blind, 3, 1)}, want: []string{CodeChannelNotFound}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			needs := map[NeedKey]*Need{}
			for _, n := range allNeeds {
				needs[n.Key] = n
			}
			items := map[ItemKey]*Item{}
			for _, it := range allItems {
				items[it.Key] = it
			}
			st := newState(&f.cat, needs, items)
			for _, c := range tc.conns {
				st.add(c)
			}
			got := codes(st.evaluate())
			want := append([]string{}, tc.want...)
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Fatalf("got %v, want %v", got, want)
			}
			// problemsFor of the last connection sees the same errors
			// that involve it (what connect refuses).
			last := tc.conns[len(tc.conns)-1]
			hasErr := false
			for _, p := range st.evaluate() {
				if p.Severity == SeverityError && slices.Contains(p.Conns, last.ID) {
					hasErr = true
				}
			}
			if (firstError(st.problemsFor(last), last.ID) != nil) != hasErr {
				t.Fatalf("problemsFor disagrees with evaluate")
			}
			// Removing every connection leaves no problem.
			for _, c := range tc.conns {
				st.remove(c)
			}
			if len(st.evaluate()) != 0 || len(st.phys) != len(st.phys) {
				t.Fatalf("problems left after removing")
			}
		})
	}
}

func TestSlotNumbering(t *testing.T) {
	f := newFixture()
	// A module with 2 native blind channels and 4 relays usable as 2 more.
	caps := f.relayCaps()
	caps.Channels = append([]capabilities.ChannelCapability{{OutputKindID: f.blind, Count: 2}}, caps.Channels...)
	it := f.item(1, caps)
	if n := slotCount(it, f.blind); n != 4 {
		t.Fatalf("blind slots %d, want 4", n)
	}
	sl, ok := slotOf(it, f.blind, 2)
	if !ok || sl.cap.OutputKindID != f.blind || sl.first != 2 {
		t.Fatalf("native slot: %+v", sl)
	}
	sl, ok = slotOf(it, f.blind, 4)
	if !ok || sl.cap.OutputKindID != f.relay || sl.first != 3 || sl.last != 4 {
		t.Fatalf("alternative slot: %+v", sl)
	}
}
