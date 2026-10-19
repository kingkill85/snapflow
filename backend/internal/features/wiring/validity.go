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
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
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
	CodePowerUnknown      = "power_unknown"
)

// Load type keys of motors (seeded, D310): a blind output's motorType must
// match them.
var motorOf = map[string]string{"ac_motor": "ac", "dc_motor": "dc"}

// NeedKey identifies a need (ids are unique per plan, D339).
type NeedKey struct{ PlanID, ID uuid.UUID }

// ItemKey identifies a placement or board module.
type ItemKey struct{ PlanID, ID uuid.UUID }

// ChannelKey identifies a logical channel of an item (D378, D410): a
// native channel by its kind and number (Base = uuid.Nil), an alternative
// channel (D303) by its kind, the kind whose channels it uses (Base) and its
// group number. Display numbers (channelNo in the API) are derived from the
// item's current capabilities (channelNoOf, channelKeyOf, D387).
type ChannelKey struct {
	Item ItemKey
	Kind uuid.UUID
	Base uuid.UUID
	No   int
}

// Alternative reports whether the channel is an alternative group.
func (k ChannelKey) Alternative() bool { return k.Base != uuid.Nil }

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
	// PowerFactor per load type (W -> A, D407); missing = 1.
	PowerFactor map[uuid.UUID]float64
}

func (c *Catalog) powerFactor(lt uuid.UUID) float64 {
	if pf, ok := c.PowerFactor[lt]; ok && pf > 0 {
		return pf
	}
	return 1
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
	// ProductName of its variant (findings name items without channels).
	ProductName *i18n.Text
}

// Conn is a connection.
type Conn struct {
	ID      uuid.UUID
	Need    NeedKey
	Units   int32
	Channel ChannelKey
	Pinned  bool
	BatchID *uuid.UUID
	// StoredNo is the channel number stored with it (shown when the
	// channel no longer resolves).
	StoredNo int
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

// slotOf resolves a channel of an item: a native channel is the channel
// No of its kind; an alternative group k of the base kind's channels uses
// base channels (k−1)·per+1..k·per (D303, D410).
func slotOf(it *Item, ch ChannelKey) (slot, bool) {
	if it == nil || ch.No < 1 {
		return slot{}, false
	}
	for _, c := range it.Caps.Channels {
		if !ch.Alternative() {
			if c.OutputKindID == ch.Kind && ch.No <= c.Count {
				return slot{cap: c, first: ch.No, last: ch.No}, true
			}
			continue
		}
		if c.OutputKindID != ch.Base {
			continue
		}
		for _, a := range c.Alternatives {
			if a.OutputKindID == ch.Kind && a.Per >= 1 && ch.No <= a.Max {
				return slot{cap: c, first: (ch.No-1)*a.Per + 1, last: ch.No * a.Per}, true
			}
		}
	}
	return slot{}, false
}

// kindChannels lists the channels of one kind on an item in display order:
// native first (1..count), then the alternative groups of every channel
// kind that offers the kind, in output kind order (D387).
func kindChannels(it *Item, kind uuid.UUID) []ChannelKey {
	if it == nil {
		return nil
	}
	var out []ChannelKey
	for _, c := range it.Caps.Channels {
		if c.OutputKindID == kind {
			for no := 1; no <= c.Count; no++ {
				out = append(out, ChannelKey{Item: it.Key, Kind: kind, No: no})
			}
		}
	}
	for _, c := range it.Caps.Channels {
		for _, a := range c.Alternatives {
			if a.OutputKindID == kind && a.Per >= 1 {
				for g := 1; g <= a.Max; g++ {
					out = append(out, ChannelKey{Item: it.Key, Kind: kind, Base: c.OutputKindID, No: g})
				}
			}
		}
	}
	return out
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
			if a.OutputKindID == kind && a.Per >= 1 {
				n += a.Max
			}
		}
	}
	return n
}

// channelKeyOf resolves a display number (1..slotCount) of a kind; a
// number beyond them is a native channel that does not exist.
func channelKeyOf(it *Item, key ItemKey, kind uuid.UUID, no int) ChannelKey {
	if it != nil && no >= 1 {
		if chs := kindChannels(it, kind); no <= len(chs) {
			return chs[no-1]
		}
	}
	return ChannelKey{Item: key, Kind: kind, No: no}
}

// channelNoOf is the display number of a channel (false: it does not
// exist on the item's current capabilities).
func channelNoOf(it *Item, ch ChannelKey) (int, bool) {
	if _, ok := slotOf(it, ch); !ok {
		return 0, false
	}
	for i, k := range kindChannels(it, ch.Kind) {
		if k == ch {
			return i + 1, true
		}
	}
	return 0, false
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
	sl, ok := slotOf(s.items[ch.Item], ch)
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
	// Searched from the end: trials remove the connection they just added
	// (D415). The order of s.conns is kept.
	del := func(list []*Conn) []*Conn {
		for i := len(list) - 1; i >= 0; i-- {
			if list[i] == c {
				return slices.Delete(list, i, i+1)
			}
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
// type, the motor type matches (an alternative channel, e.g. a relay pair
// used as a blind output, without motorType drives AC motors, D414).
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
	motor := it.Caps.MotorType
	if motor == "" && c.Channel.Alternative() {
		motor = "ac"
	}
	if n.LoadTypeID != nil && motor != "" {
		if m, ok := motorOf[s.cat.LoadTypeKey[*n.LoadTypeID]]; ok && m != motor {
			out := p(CodeMotorMismatch)
			out[0].Params = map[string]any{"motorType": motor, "needMotorType": m}
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

// limitOf is the limit that applies to one load type: the lowest of its
// own limits and the limits without a load type (D408).
func limitOf(limits []capabilities.Limit, lt uuid.UUID) (float64, bool) {
	value, ok := 0.0, false
	for _, l := range limits {
		if l.LoadTypeID == nil || (lt != uuid.Nil && *l.LoadTypeID == lt) {
			if !ok || l.Value < value {
				value, ok = l.Value, true
			}
		}
	}
	return value, ok
}

// usage is a load against limits per load type: Σ (load of a type ÷ the
// limit of that type) ≤ 1 (D408). unknown are the present types without a
// limit (when there are limits at all).
type usage struct {
	load, utilisation float64
	limited           []uuid.UUID
	single            float64 // the limit when only one type is limited
	unknown           []uuid.UUID
}

func usageOf(limits []capabilities.Limit, types []uuid.UUID, byType map[uuid.UUID]float64) usage {
	var u usage
	if len(limits) == 0 {
		return u
	}
	for _, t := range types {
		lim, ok := limitOf(limits, t)
		if !ok {
			u.unknown = append(u.unknown, t)
			continue
		}
		v := byType[t]
		u.limited = append(u.limited, t)
		u.load += v
		u.single = lim
		switch {
		case lim > 0:
			u.utilisation += v / lim
		case v > 0:
			u.utilisation += 100 // a limit of 0 with load: far over
		}
	}
	return u
}

func (u usage) over() bool { return len(u.limited) > 0 && u.utilisation > 1+1e-9 }

// params of an overload: the load, the limit (for several load types the
// effective limit of the mix: load ÷ utilisation) and the utilisation %.
func (u usage) params(loadKey, limitKey string) map[string]any {
	limit := u.single
	if len(u.limited) > 1 && u.utilisation > 0 {
		limit = round2(u.load / u.utilisation)
	}
	out := map[string]any{loadKey: round2(u.load), limitKey: limit, "utilisationPercent": math.Round(u.utilisation*1000) / 10}
	if len(u.limited) > 1 {
		// Several load types: the limit is that of the mix (D417).
		out["mixedLoads"] = true
	}
	return out
}

// loadSum is the load of connections that are valid on their own.
type loadSum struct {
	totalW  float64
	types   []uuid.UUID           // present load types (uuid.Nil: none), first seen
	byTypeW map[uuid.UUID]float64 // known W per type
	byTypeA map[uuid.UUID]float64 // known A per type (W ÷ (V · PF))
	unknown []*Conn               // power unknown
	dcNoV   bool                  // a DC motor on a channel without own voltage
}

// isDC: a DC motor need (load type dc_motor) or a channel of an item whose
// motors are DC.
func (s *state) isDC(n *Need, it *Item) bool {
	if n.LoadTypeID != nil && s.cat.LoadTypeKey[*n.LoadTypeID] == "dc_motor" {
		return true
	}
	return it.Caps.MotorType == "dc"
}

// loadOf sums connections: W per load type, A per load type with the
// channel's voltage (channel_voltage, else the product type's nominal
// voltage) and the load type's power factor (D407).
func (s *state) loadOf(conns []*Conn) loadSum {
	ls := loadSum{byTypeW: map[uuid.UUID]float64{}, byTypeA: map[uuid.UUID]float64{}}
	for _, c := range conns {
		n := s.needs[c.Need]
		it := s.items[c.Channel.Item]
		sl, ok := s.slot(c.Channel)
		if n == nil || it == nil || !ok {
			continue
		}
		lt := uuid.Nil
		if n.LoadTypeID != nil {
			lt = *n.LoadTypeID
		}
		if !slices.Contains(ls.types, lt) {
			ls.types = append(ls.types, lt)
		}
		if n.PowerCW == nil {
			ls.unknown = append(ls.unknown, c)
			continue
		}
		w := float64(int64(c.Units)**n.PowerCW) / 100
		ls.totalW += w
		ls.byTypeW[lt] += w
		v := it.Voltage
		if sl.cap.VoltageV != nil {
			v = *sl.cap.VoltageV
		} else if s.isDC(n, it) {
			ls.dcNoV = true
			continue
		}
		if v > 0 {
			ls.byTypeA[lt] += w / (v * s.cat.powerFactor(lt))
		}
	}
	return ls
}

// validLoads are the connections that are valid on their own (a need that
// is gone or not served, a missing channel or a motor mismatch is
// reported per connection and carries no load).
func (s *state) validLoads(conns []*Conn) []*Conn {
	var out []*Conn
	for _, c := range conns {
		if len(s.connProblems(c)) == 0 {
			out = append(out, c)
		}
	}
	return out
}

func (s *state) unknownParams(lt uuid.UUID) map[string]any {
	params := map[string]any{}
	if lt != uuid.Nil {
		params["loadTypeKey"] = s.cat.LoadTypeKey[lt]
	}
	return params
}

// channelProblems are the rules of one channel: alternatives and their
// base channels are not used both ways (D303); a circuit only when every
// need allows circuits and they share the function type (else one need
// unit); the W and A limits per load type (several load types: Σ load ÷
// limit ≤ 1, D408; A via the channel voltage and power factor, D407), the
// minimum load; unknown powers or limits are warnings.
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
	loads := s.validLoads(conns)
	if len(loads) == 0 {
		return out
	}
	ls := s.loadOf(loads)
	uw := usageOf(sl.cap.LimitsW, ls.types, ls.byTypeW)
	for _, lt := range uw.unknown {
		p(SeverityWarning, CodeLimitUnknown, s.unknownParams(lt))
	}
	if uw.over() {
		p(SeverityError, CodeChannelOverloadW, uw.params("loadW", "limitW"))
	}
	if len(sl.cap.LimitsA) > 0 {
		ua := usageOf(sl.cap.LimitsA, ls.types, ls.byTypeA)
		for _, lt := range ua.unknown {
			if !slices.Contains(uw.unknown, lt) {
				p(SeverityWarning, CodeLimitUnknown, s.unknownParams(lt))
			}
		}
		if ls.dcNoV {
			p(SeverityWarning, CodeLimitUnknown, map[string]any{"loadTypeKey": "dc_motor"})
		}
		if ua.over() {
			params := ua.params("currentA", "limitA")
			v := it.Voltage
			if sl.cap.VoltageV != nil {
				v = *sl.cap.VoltageV
			}
			params["voltage"] = v
			p(SeverityError, CodeChannelOverloadA, params)
		}
	}
	if lim, ok, _ := limitFor(sl.cap.MinLoadsW, ls.types, false); ok && len(ls.unknown) == 0 && ls.totalW < lim-1e-9 {
		p(SeverityWarning, CodeMinLoad, map[string]any{"loadW": round2(ls.totalW), "minW": lim})
	}
	// A power that is not known cannot be checked against the limits
	// (and the minimum load is skipped): one warning per connection (D408).
	limited := len(sl.cap.LimitsW) > 0 || len(sl.cap.LimitsA) > 0 || len(sl.cap.MinLoadsW) > 0 ||
		len(it.Caps.ModuleTotalsW) > 0 || it.Caps.ModuleTotalA != nil
	if limited {
		for _, c := range ls.unknown {
			c2, nk := ch, c.Need
			label := ""
			if n := s.needs[c.Need]; n != nil {
				label = n.Label
			}
			out = append(out, Problem{Severity: SeverityWarning, Code: CodePowerUnknown, Conns: []uuid.UUID{c.ID}, Need: &nk, Channel: &c2,
				Params: map[string]any{"label": label}})
		}
	}
	return out
}

// itemParams name an item in findings (D412).
func itemParams(it *Item, params map[string]any) map[string]any {
	params["label"] = it.Label
	if it.ProductName != nil {
		params["productName"] = *it.ProductName
	}
	return params
}

// itemProblems are the module totals over the connections valid on their
// own: W per load type (a total without load type: all load; a need
// without load type against totals that are all per load type:
// limit_unknown, D408) and A (channel voltage, power factor, D407).
func (s *state) itemProblems(key ItemKey) []Problem {
	it := s.items[key]
	if it == nil || len(s.byItem[key]) == 0 || (len(it.Caps.ModuleTotalsW) == 0 && it.Caps.ModuleTotalA == nil) {
		return nil
	}
	conns := s.validLoads(s.byItem[key])
	if len(conns) == 0 {
		return nil
	}
	var out []Problem
	p := func(sev Severity, code string, params map[string]any) {
		k := key
		out = append(out, Problem{Severity: sev, Code: code, Conns: ids(conns), Item: &k, Params: itemParams(it, params)})
	}
	ls := s.loadOf(conns)
	anyTotal := false
	for _, l := range it.Caps.ModuleTotalsW {
		w := ls.totalW
		params := map[string]any{"limitW": l.Value}
		if l.LoadTypeID != nil {
			w = ls.byTypeW[*l.LoadTypeID]
			params["loadTypeKey"] = s.cat.LoadTypeKey[*l.LoadTypeID]
		} else {
			anyTotal = true
		}
		if w > l.Value+1e-9 {
			params["loadW"] = round2(w)
			p(SeverityError, CodeModuleOverloadW, params)
		}
	}
	if len(it.Caps.ModuleTotalsW) > 0 && !anyTotal && slices.Contains(ls.types, uuid.Nil) {
		p(SeverityWarning, CodeLimitUnknown, map[string]any{})
	}
	if it.Caps.ModuleTotalA != nil {
		a := 0.0
		for _, v := range ls.byTypeA {
			a += v
		}
		if ls.dcNoV {
			p(SeverityWarning, CodeLimitUnknown, map[string]any{"loadTypeKey": "dc_motor"})
		}
		if a > *it.Caps.ModuleTotalA+1e-9 {
			p(SeverityError, CodeModuleOverloadA, map[string]any{"currentA": round2(a), "limitA": *it.Caps.ModuleTotalA, "voltage": it.Voltage})
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
