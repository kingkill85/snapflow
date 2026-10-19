package wiring

// The validity of connections (spec 3d): one set of rules used by connect,
// auto-connect and the checks. Everything here is pure and in memory: a
// state holds the needs, items and connections of a version with indexes,
// and the problem functions evaluate one connection, channel, item or need.

import (
	"math"
	"slices"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
)

// Severity of a problem or finding.
type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Validity problem codes (connect refuses errors as connection.<code>).
const (
	CodeNeedNotFound      = "need_not_found"
	CodeTargetNotFound    = "target_not_found"
	CodeChannelNotFound   = "channel_not_found"
	CodeFunctionNotServed = "function_not_served"
	CodeMotorMismatch     = "motor_mismatch"
	CodeUnitsExceeded     = "units_exceeded"
	CodeChannelConflict   = "channel_conflict"
	CodeCircuitNotAllowed = "circuit_not_allowed"
	CodeChannelOverloadW  = "channel_overload_w"
	CodeChannelOverloadA  = "channel_overload_a"
	CodeLimitUnknown      = "limit_unknown"
	CodeMinLoad           = "min_load"
	CodeModuleOverloadW   = "module_overload_w"
	CodeModuleOverloadA   = "module_overload_a"
)

// Load type keys of motors (seeded, D310): a blind output's motorType must
// match them.
var motorOf = map[string]string{"ac_motor": "ac", "dc_motor": "dc"}

// NeedKey identifies a need (ids are unique per plan, D339).
type NeedKey struct{ PlanID, ID uuid.UUID }

// ItemKey identifies a placement or board module.
type ItemKey struct{ PlanID, ID uuid.UUID }

// ChannelKey identifies a channel: an item's output kind and number (D378).
type ChannelKey struct {
	Item ItemKey
	Kind uuid.UUID
	No   int
}

// Catalog are the catalog facts the rules need.
type Catalog struct {
	// Served: output kind -> function types it serves (active kinds).
	Served map[uuid.UUID]map[uuid.UUID]bool
	// KindOrder and KindKey of the active output kinds.
	KindOrder map[uuid.UUID]int
	KindKey   map[uuid.UUID]string
	// Circuit: function types that allow circuits; FunctionKey their keys.
	Circuit     map[uuid.UUID]bool
	FunctionKey map[uuid.UUID]string
	LoadTypeKey map[uuid.UUID]string
}

// Need is a need with its facts.
type Need struct {
	Key            NeedKey
	ZoneID         *uuid.UUID
	FunctionTypeID uuid.UUID
	Quantity       int32
	// PowerCW is the power per unit in hundredths of W (exact); nil unknown.
	PowerCW    *int64
	LoadTypeID *uuid.UUID
	Label      string
}

// Item is a placement or module with its capabilities.
type Item struct {
	Key   ItemKey
	Board bool
	// HasVariant: the catalog variant exists (else it has no channels).
	HasVariant bool
	Caps       capabilities.Capabilities
	// Voltage is the nominal voltage of its product type (W -> A).
	Voltage float64
	ZoneID  *uuid.UUID
	Label   string
}

// Conn is a connection.
type Conn struct {
	ID      uuid.UUID
	Need    NeedKey
	Units   int32
	Channel ChannelKey
	Pinned  bool
	BatchID *uuid.UUID
}

// Problem is a broken rule. Conns are the connections involved; Need,
// Channel or Item say where.
type Problem struct {
	Severity Severity
	Code     string
	Conns    []uuid.UUID
	Need     *NeedKey
	Channel  *ChannelKey
	Item     *ItemKey
	Params   map[string]any
}

// slot is what a logical channel is made of: channels of a base kind (the
// kind itself, or the kind an alternative uses, D303), base numbers
// First..Last, with the base channels' limits.
type slot struct {
	cap         capabilities.ChannelCapability
	first, last int
}

// slotOf resolves a channel of an item: native channels are numbered first
// (1..count); then the alternative groups of each channel kind that offers
// the kind, in channel (output kind) order, group k using base channels
// (k−1)·per+1..k·per.
func slotOf(it *Item, kind uuid.UUID, no int) (slot, bool) {
	if it == nil || no < 1 {
		return slot{}, false
	}
	for _, c := range it.Caps.Channels {
		if c.OutputKindID == kind {
			if no <= c.Count {
				return slot{cap: c, first: no, last: no}, true
			}
			no -= c.Count
		}
	}
	for _, c := range it.Caps.Channels {
		for _, a := range c.Alternatives {
			if a.OutputKindID != kind || a.Per < 1 {
				continue
			}
			if no <= a.Max {
				return slot{cap: c, first: (no-1)*a.Per + 1, last: no * a.Per}, true
			}
			no -= a.Max
		}
	}
	return slot{}, false
}

// slotCount is how many channels of kind an item offers (native and as an
// alternative).
func slotCount(it *Item, kind uuid.UUID) int {
	n := 0
	for _, c := range it.Caps.Channels {
		if c.OutputKindID == kind {
			n += c.Count
		}
		for _, a := range c.Alternatives {
			if a.OutputKindID == kind {
				n += a.Max
			}
		}
	}
	return n
}

// physKey is one base channel of an item.
type physKey struct {
	Item ItemKey
	Kind uuid.UUID
	No   int
}

// state is the needs, items and connections of a version with indexes.
type state struct {
	cat       *Catalog
	needs     map[NeedKey]*Need
	items     map[ItemKey]*Item
	conns     []*Conn
	byChannel map[ChannelKey][]*Conn
	byItem    map[ItemKey][]*Conn
	byNeed    map[NeedKey][]*Conn
	// phys: base channel -> logical channels using it (with a count).
	phys  map[physKey]map[ChannelKey]int
	slots map[ChannelKey]slot
}

func newState(cat *Catalog, needs map[NeedKey]*Need, items map[ItemKey]*Item) *state {
	return &state{cat: cat, needs: needs, items: items, byChannel: map[ChannelKey][]*Conn{}, byItem: map[ItemKey][]*Conn{},
		byNeed: map[NeedKey][]*Conn{}, phys: map[physKey]map[ChannelKey]int{}, slots: map[ChannelKey]slot{}}
}

func (s *state) slot(ch ChannelKey) (slot, bool) {
	if sl, ok := s.slots[ch]; ok {
		return sl, true
	}
	sl, ok := slotOf(s.items[ch.Item], ch.Kind, ch.No)
	if ok {
		s.slots[ch] = sl
	}
	return sl, ok
}

func (s *state) add(c *Conn) {
	s.conns = append(s.conns, c)
	s.byChannel[c.Channel] = append(s.byChannel[c.Channel], c)
	s.byItem[c.Channel.Item] = append(s.byItem[c.Channel.Item], c)
	s.byNeed[c.Need] = append(s.byNeed[c.Need], c)
	if sl, ok := s.slot(c.Channel); ok {
		for b := sl.first; b <= sl.last; b++ {
			k := physKey{c.Channel.Item, sl.cap.OutputKindID, b}
			if s.phys[k] == nil {
				s.phys[k] = map[ChannelKey]int{}
			}
			s.phys[k][c.Channel]++
		}
	}
}

func (s *state) remove(c *Conn) {
	del := func(list []*Conn) []*Conn {
		if i := slices.Index(list, c); i >= 0 {
			return slices.Delete(list, i, i+1)
		}
		return list
	}
	s.conns = del(s.conns)
	s.byChannel[c.Channel] = del(s.byChannel[c.Channel])
	s.byItem[c.Channel.Item] = del(s.byItem[c.Channel.Item])
	s.byNeed[c.Need] = del(s.byNeed[c.Need])
	if sl, ok := s.slot(c.Channel); ok {
		for b := sl.first; b <= sl.last; b++ {
			k := physKey{c.Channel.Item, sl.cap.OutputKindID, b}
			if s.phys[k][c.Channel]--; s.phys[k][c.Channel] <= 0 {
				delete(s.phys[k], c.Channel)
			}
		}
	}
}

// busy: the channel holds a connection, or one of its base channels is
// used by another logical channel.
func (s *state) busy(ch ChannelKey) bool {
	if len(s.byChannel[ch]) > 0 {
		return true
	}
	sl, ok := s.slot(ch)
	if !ok {
		return true
	}
	for b := sl.first; b <= sl.last; b++ {
		if len(s.phys[physKey{ch.Item, sl.cap.OutputKindID, b}]) > 0 {
			return true
		}
	}
	return false
}

func ids(conns []*Conn) []uuid.UUID {
	out := make([]uuid.UUID, len(conns))
	for i, c := range conns {
		out[i] = c.ID
	}
	return out
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// connProblems are the rules of one connection on its own: the need and
// target exist, the channel exists, its kind serves the need's function
// type, the motor type matches.
func (s *state) connProblems(c *Conn) []Problem {
	p := func(code string) []Problem {
		ch := c.Channel
		return []Problem{{Severity: SeverityError, Code: code, Conns: []uuid.UUID{c.ID}, Need: &c.Need, Channel: &ch, Params: map[string]any{}}}
	}
	n := s.needs[c.Need]
	if n == nil {
		return p(CodeNeedNotFound)
	}
	it := s.items[c.Channel.Item]
	if it == nil {
		return p(CodeTargetNotFound)
	}
	if _, ok := s.slot(c.Channel); !ok || !it.HasVariant {
		return p(CodeChannelNotFound)
	}
	if !s.cat.Served[c.Channel.Kind][n.FunctionTypeID] {
		return p(CodeFunctionNotServed)
	}
	if n.LoadTypeID != nil && it.Caps.MotorType != "" {
		if m, ok := motorOf[s.cat.LoadTypeKey[*n.LoadTypeID]]; ok && m != it.Caps.MotorType {
			out := p(CodeMotorMismatch)
			out[0].Params = map[string]any{"motorType": it.Caps.MotorType, "needMotorType": m}
			return out
		}
	}
	return nil
}

// limitFor returns the strictest (lowest, or for minimums highest) value
// of the limits that apply to the load types present: a limit without a
// load type applies to any load. unknown lists load types (uuid.Nil = a
// need without one) without a limit when the limits are per load type.
func limitFor(limits []capabilities.Limit, present []uuid.UUID, lowest bool) (value float64, ok bool, unknown []uuid.UUID) {
	pick := func(v float64) {
		if !ok || (lowest && v < value) || (!lowest && v > value) {
			value, ok = v, true
		}
	}
	anyLoad := false
	for _, l := range limits {
		if l.LoadTypeID == nil {
			pick(l.Value)
			anyLoad = true
		}
	}
	for _, lt := range present {
		found := false
		for _, l := range limits {
			if l.LoadTypeID != nil && *l.LoadTypeID == lt {
				pick(l.Value)
				found = true
			}
		}
		if !found && !anyLoad && len(limits) > 0 {
			unknown = append(unknown, lt)
		}
	}
	return value, ok, unknown
}

// load sums units × power of connections: total W (known powers),
// whether every power is known, and the load types present (uuid.Nil for
// a need without load type) in first-seen order; byType is W per load type.
func (s *state) load(conns []*Conn) (totalW float64, allKnown bool, present []uuid.UUID, byType map[uuid.UUID]float64) {
	allKnown = true
	byType = map[uuid.UUID]float64{}
	var cw int64
	for _, c := range conns {
		n := s.needs[c.Need]
		if n == nil {
			continue
		}
		lt := uuid.Nil
		if n.LoadTypeID != nil {
			lt = *n.LoadTypeID
		}
		if !slices.Contains(present, lt) {
			present = append(present, lt)
		}
		if n.PowerCW == nil {
			allKnown = false
			continue
		}
		v := int64(c.Units) * *n.PowerCW
		cw += v
		byType[lt] += float64(v) / 100
	}
	return float64(cw) / 100, allKnown, present, byType
}

// channelProblems are the rules of one channel: alternatives and their
// base channels are not used both ways (D303); a circuit only when every
// need allows circuits and they share the function type (else one need
// unit); the W limit per load type (several load types: the strictest that
// applies), the A limit via the nominal voltage, the minimum load.
func (s *state) channelProblems(ch ChannelKey) []Problem {
	conns := s.byChannel[ch]
	if len(conns) == 0 {
		return nil
	}
	sl, ok := s.slot(ch)
	it := s.items[ch.Item]
	if !ok || it == nil {
		return nil // reported per connection
	}
	var out []Problem
	p := func(sev Severity, code string, params map[string]any) {
		c := ch
		out = append(out, Problem{Severity: sev, Code: code, Conns: ids(conns), Channel: &c, Params: params})
	}
	for b := sl.first; b <= sl.last; b++ {
		if len(s.phys[physKey{ch.Item, sl.cap.OutputKindID, b}]) > 1 {
			p(SeverityError, CodeChannelConflict, map[string]any{"baseChannel": b})
			break
		}
	}
	units := int32(0)
	circuit := true
	var ft *uuid.UUID
	for _, c := range conns {
		units += c.Units
		n := s.needs[c.Need]
		if n == nil {
			continue
		}
		if !s.cat.Circuit[n.FunctionTypeID] || (ft != nil && *ft != n.FunctionTypeID) {
			circuit = false
		}
		f := n.FunctionTypeID
		ft = &f
	}
	if units > 1 && !circuit {
		p(SeverityError, CodeCircuitNotAllowed, map[string]any{"units": units})
	}
	// Loads count the connections that are valid on their own (a need
	// that is gone or not served is reported per connection).
	var loads []*Conn
	for _, c := range conns {
		if n := s.needs[c.Need]; n != nil && s.cat.Served[ch.Kind][n.FunctionTypeID] {
			loads = append(loads, c)
		}
	}
	if len(loads) == 0 {
		return out
	}
	totalW, allKnown, present, _ := s.load(loads)
	if lim, ok, unknown := limitFor(sl.cap.LimitsW, present, true); ok || len(unknown) > 0 {
		for _, lt := range unknown {
			params := map[string]any{}
			if lt != uuid.Nil {
				params["loadTypeKey"] = s.cat.LoadTypeKey[lt]
			}
			p(SeverityWarning, CodeLimitUnknown, params)
		}
		if ok && totalW > lim+1e-9 {
			p(SeverityError, CodeChannelOverloadW, map[string]any{"loadW": round2(totalW), "limitW": lim})
		}
	}
	if lim, ok, _ := limitFor(sl.cap.LimitsA, present, true); ok && it.Voltage > 0 {
		if a := totalW / it.Voltage; a > lim+1e-9 {
			p(SeverityError, CodeChannelOverloadA, map[string]any{"currentA": round2(a), "limitA": lim, "voltage": it.Voltage})
		}
	}
	if lim, ok, _ := limitFor(sl.cap.MinLoadsW, present, false); ok && allKnown && totalW < lim-1e-9 {
		p(SeverityWarning, CodeMinLoad, map[string]any{"loadW": round2(totalW), "minW": lim})
	}
	return out
}

// itemProblems are the module totals: W per load type (a total without
// load type: all load) and A via the nominal voltage.
func (s *state) itemProblems(key ItemKey) []Problem {
	conns := s.byItem[key]
	it := s.items[key]
	if len(conns) == 0 || it == nil {
		return nil
	}
	var out []Problem
	p := func(code string, params map[string]any) {
		k := key
		out = append(out, Problem{Severity: SeverityError, Code: code, Conns: ids(conns), Item: &k, Params: params})
	}
	totalW, _, _, byType := s.load(conns)
	for _, l := range it.Caps.ModuleTotalsW {
		w := totalW
		params := map[string]any{"limitW": l.Value}
		if l.LoadTypeID != nil {
			w = byType[*l.LoadTypeID]
			params["loadTypeKey"] = s.cat.LoadTypeKey[*l.LoadTypeID]
		}
		if w > l.Value+1e-9 {
			params["loadW"] = round2(w)
			p(CodeModuleOverloadW, params)
		}
	}
	if it.Caps.ModuleTotalA != nil && it.Voltage > 0 {
		if a := totalW / it.Voltage; a > *it.Caps.ModuleTotalA+1e-9 {
			p(CodeModuleOverloadA, map[string]any{"currentA": round2(a), "limitA": *it.Caps.ModuleTotalA, "voltage": it.Voltage})
		}
	}
	return out
}

// needProblems: Σ units over a need's connections ≤ its quantity.
func (s *state) needProblems(key NeedKey) []Problem {
	conns := s.byNeed[key]
	n := s.needs[key]
	if n == nil || len(conns) == 0 {
		return nil
	}
	units := int32(0)
	for _, c := range conns {
		units += c.Units
	}
	if units > n.Quantity {
		k := key
		return []Problem{{Severity: SeverityError, Code: CodeUnitsExceeded, Conns: ids(conns), Need: &k,
			Params: map[string]any{"units": units, "quantity": n.Quantity}}}
	}
	return nil
}

// problemsFor are the problems a connection takes part in: its own, its
// channel's (and those of channels sharing its base channels), its item's
// and its need's.
func (s *state) problemsFor(c *Conn) []Problem {
	out := s.connProblems(c)
	out = append(out, s.channelProblems(c.Channel)...)
	out = append(out, s.itemProblems(c.Channel.Item)...)
	out = append(out, s.needProblems(c.Need)...)
	return out
}

// firstError returns the first error among problems that involve id.
func firstError(problems []Problem, id uuid.UUID) *Problem {
	for i := range problems {
		if problems[i].Severity == SeverityError && slices.Contains(problems[i].Conns, id) {
			return &problems[i]
		}
	}
	return nil
}

// evaluate returns every problem of the state, deterministically:
// connections in order, then channels, items and needs in the order of
// their first connection.
func (s *state) evaluate() []Problem {
	var out []Problem
	seenCh := map[ChannelKey]bool{}
	seenIt := map[ItemKey]bool{}
	seenNeed := map[NeedKey]bool{}
	var chs []ChannelKey
	var its []ItemKey
	var nds []NeedKey
	for _, c := range s.conns {
		out = append(out, s.connProblems(c)...)
		if !seenCh[c.Channel] {
			seenCh[c.Channel] = true
			chs = append(chs, c.Channel)
		}
		if !seenIt[c.Channel.Item] {
			seenIt[c.Channel.Item] = true
			its = append(its, c.Channel.Item)
		}
		if !seenNeed[c.Need] {
			seenNeed[c.Need] = true
			nds = append(nds, c.Need)
		}
	}
	for _, ch := range chs {
		out = append(out, s.channelProblems(ch)...)
	}
	for _, it := range its {
		out = append(out, s.itemProblems(it)...)
	}
	for _, n := range nds {
		out = append(out, s.needProblems(n)...)
	}
	return out
}
