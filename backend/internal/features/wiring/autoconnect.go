package wiring

// Auto-connect (spec 3d, D391 as amended by D409): connects the
// unconnected units of needs to free channels, deterministically, never
// adding products and never touching existing connections.
//
// Order of needs: most constrained first — function types ranked by
// scarcity (free serving channels ÷ missing units, lowest first), within a
// rank plan order → zone order (needs outside every zone last) → need order
// → unit. Targets of a need, in this order:
//  1. for a function type that allows circuits: channels that already hold
//     needs of the same plan, zone and function type (existing connections
//     and this run's), in the order they were first used — the circuit is
//     kept per zone and function type;
//  2. free channels of the devices placed in the need's zone on its floorplan;
//  3. free board channels.
//
// Within 2 and 3 a unit takes the first channel by: native channels before
// alternative groups; kinds serving fewer function types first (a relay
// before a dimmer for a switch-only need); channels that do not break a
// still-whole alternative group first (keeps relay pairs for blinds); then
// the fill order (boards in plan order → modules by row and offset → output
// kind order → channel number), so a module fills before the next.
//
// A channel is free when it holds no connection and none of its base
// channels is used by another channel (D303). A unit goes to the first
// target where the connection breaks no rule (validity errors; warnings do
// not stop it); several units of a need on one channel are one connection.
// Then a single-step repair: for each unit still unconnected, one
// connection of this run that alone blocks a serving channel is moved to
// another free channel serving its need, if both then fit. The result is
// listed in need order.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/wiring/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Reasons a need cannot be connected.
const (
	ReasonNoChannelServes = "no_channel_serves"
	ReasonNoFreeChannel   = "no_free_channel"
	ReasonLimitsExceeded  = "limits_exceeded"
)

type circuitKey struct {
	plan uuid.UUID
	zone uuid.UUID
	ft   uuid.UUID
}

// needSig is what decides whether one unit of a need fits an empty channel:
// a failure is remembered per (signature, channel) during the main pass,
// where channels and items only get busier (D415).
type needSig struct {
	ft, lt uuid.UUID
	power  int64 // -1: unknown
}

func sigOf(n *Need) needSig {
	s := needSig{ft: n.FunctionTypeID, power: -1}
	if n.LoadTypeID != nil {
		s.lt = *n.LoadTypeID
	}
	if n.PowerCW != nil {
		s.power = *n.PowerCW
	}
	return s
}

type failKey struct {
	sig needSig
	ch  ChannelKey
}

// prefList is a list of channels in preference order, cut into classes of
// equal static rank (alternative, kinds served); cursor skips the busy
// prefix of each class (main pass only: channels only get busier).
type prefList struct {
	chans   []ChannelKey
	classes [][2]int
	cursor  []int
}

// planner is one auto-connect run.
type planner struct {
	st       *state
	fill     map[ChannelKey]int
	made     []*Conn
	run      map[uuid.UUID]bool // connections of this run
	mine     map[NeedKey]map[ChannelKey]*Conn
	failed   map[failKey]bool
	circuits map[circuitKey][]ChannelKey
	lists    map[string]*prefList
}

func keyOfCircuit(n *Need) circuitKey {
	k := circuitKey{plan: n.Key.PlanID, ft: n.FunctionTypeID}
	if n.ZoneID != nil {
		k.zone = *n.ZoneID
	}
	return k
}

func (p *planner) addCircuit(n *Need, ch ChannelKey) {
	k := keyOfCircuit(n)
	if !slices.Contains(p.circuits[k], ch) {
		p.circuits[k] = append(p.circuits[k], ch)
	}
}

// prefer orders the channels serving ft (D409): native first, kinds
// serving fewer function types first, then fill order.
func (p *planner) prefer(name string, ft uuid.UUID, all []ChannelKey) *prefList {
	if l, ok := p.lists[name]; ok {
		return l
	}
	var chans []ChannelKey
	for _, ch := range all {
		if p.st.cat.Served[ch.Kind][ft] {
			chans = append(chans, ch)
		}
	}
	rank := func(ch ChannelKey) int {
		r := len(p.st.cat.Served[ch.Kind])
		if ch.Alternative() {
			r += 1 << 20
		}
		return r
	}
	slices.SortStableFunc(chans, func(a, b ChannelKey) int {
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra - rb
		}
		return p.fill[a] - p.fill[b]
	})
	l := &prefList{chans: chans}
	for i := 0; i < len(chans); {
		j := i
		for j < len(chans) && rank(chans[j]) == rank(chans[i]) {
			j++
		}
		l.classes = append(l.classes, [2]int{i, j})
		l.cursor = append(l.cursor, i)
		i = j
	}
	p.lists[name] = l
	return l
}

// breaksGroup: a native channel whose base channel belongs to an
// alternative group whose channels are all still free.
func (p *planner) breaksGroup(ch ChannelKey) bool {
	if ch.Alternative() {
		return false
	}
	it := p.st.items[ch.Item]
	for _, c := range it.Caps.Channels {
		if c.OutputKindID != ch.Kind {
			continue
		}
		for _, a := range c.Alternatives {
			if a.Per < 1 {
				continue
			}
			g := (ch.No-1)/a.Per + 1
			if g > a.Max {
				continue
			}
			whole := true
			for b := (g-1)*a.Per + 1; b <= g*a.Per; b++ {
				if len(p.st.phys[physKey{ch.Item, ch.Kind, b}]) > 0 {
					whole = false
					break
				}
			}
			if whole {
				return true
			}
		}
	}
	return false
}

// try puts one more unit of n on ch (its connection there grows).
func (p *planner) try(n *Need, ch ChannelKey) bool {
	st := p.st
	mine := p.mine[n.Key]
	if mine == nil {
		mine = map[ChannelKey]*Conn{}
		p.mine[n.Key] = mine
	}
	if c := mine[ch]; c != nil {
		c.Units++
		if firstError(st.problemsFor(c), c.ID) == nil {
			return true
		}
		c.Units--
		return false
	}
	c := &Conn{ID: uuid.New(), Need: n.Key, Units: 1, Channel: ch}
	st.add(c)
	if firstError(st.problemsFor(c), c.ID) == nil {
		mine[ch] = c
		p.made = append(p.made, c)
		p.run[c.ID] = true
		return true
	}
	st.remove(c)
	return false
}

// pick places one unit of n on the best free channel of l.
func (p *planner) pick(n *Need, l *prefList, sawServing, sawFree *bool) bool {
	st := p.st
	sig := sigOf(n)
	if len(l.chans) > 0 {
		*sawServing = true
	}
	for ci, cl := range l.classes {
		i := l.cursor[ci]
		for i < cl[1] && st.busy(l.chans[i]) {
			i++
		}
		l.cursor[ci] = i
		for pass := 0; pass < 2; pass++ {
			for k := i; k < cl[1]; k++ {
				ch := l.chans[k]
				if st.busy(ch) || p.breaksGroup(ch) != (pass == 1) {
					continue
				}
				*sawFree = true
				fk := failKey{sig, ch}
				if p.failed[fk] {
					continue
				}
				if p.try(n, ch) {
					return true
				}
				p.failed[fk] = true
			}
		}
	}
	return false
}

// plan computes the connections auto-connect makes on st (which it
// changes) for the needs in scope.
func plan(sn *snapshot, scope AutoConnectScope) (AutoConnectPreview, []*Conn) {
	st := sn.st
	out := AutoConnectPreview{Connections: []PlannedConnection{}, Unconnectable: []Unconnectable{}}
	zoneSet := map[uuid.UUID]bool{}
	for _, id := range scope.ZoneIDs {
		zoneSet[id] = true
	}
	needSet := map[uuid.UUID]bool{}
	for _, id := range scope.NeedIDs {
		needSet[id] = true
	}
	inScope := func(n *Need) bool {
		switch scope.Scope {
		case "zones":
			return n.ZoneID != nil && zoneSet[*n.ZoneID]
		case "needs":
			return needSet[n.Key.ID]
		}
		return true
	}
	p := &planner{st: st, fill: map[ChannelKey]int{}, run: map[uuid.UUID]bool{}, mine: map[NeedKey]map[ChannelKey]*Conn{},
		failed: map[failKey]bool{}, circuits: map[circuitKey][]ChannelKey{}, lists: map[string]*prefList{}}

	// Board channels in fill order, and channels of the devices in each zone.
	var boardSlots []ChannelKey
	roomSlots := map[[2]uuid.UUID][]ChannelKey{}
	for _, pl := range sn.data.Plans {
		for _, m := range pl.Modules {
			for _, ch := range itemChannels(sn, st.items[ItemKey{pl.ID, m.ID}]) {
				p.fill[ch] = len(p.fill)
				boardSlots = append(boardSlots, ch)
			}
		}
		for _, d := range pl.Placements {
			if d.ZoneID == nil {
				continue
			}
			k := [2]uuid.UUID{pl.ID, *d.ZoneID}
			for _, ch := range itemChannels(sn, st.items[ItemKey{pl.ID, d.ID}]) {
				p.fill[ch] = len(p.fill)
				roomSlots[k] = append(roomSlots[k], ch)
			}
		}
	}
	boardFor := func(ft uuid.UUID) *prefList { return p.prefer("b"+ft.String(), ft, boardSlots) }
	roomFor := func(n *Need) *prefList {
		if n.ZoneID == nil {
			return &prefList{}
		}
		return p.prefer("r"+n.Key.PlanID.String()+n.ZoneID.String()+n.FunctionTypeID.String(), n.FunctionTypeID,
			roomSlots[[2]uuid.UUID{n.Key.PlanID, *n.ZoneID}])
	}

	// Circuits so far, from existing connections.
	for _, c := range st.conns {
		if n := st.needs[c.Need]; n != nil && st.cat.Circuit[n.FunctionTypeID] {
			p.addCircuit(n, c.Channel)
		}
	}

	// Needs in plan → zone → need order (the display order).
	type ordered struct {
		n                 *Need
		plan, zone, index int
		missing           int32
	}
	var needs []ordered
	for pi, pl := range sn.data.Plans {
		zoneIdx := map[uuid.UUID]int{}
		for i, z := range pl.Zones {
			zoneIdx[z.ID] = i
		}
		for i, wn := range pl.Needs {
			n := st.needs[NeedKey{pl.ID, wn.ID}]
			zi := len(pl.Zones)
			if n.ZoneID != nil {
				if v, ok := zoneIdx[*n.ZoneID]; ok {
					zi = v
				}
			}
			needs = append(needs, ordered{n: n, plan: pi, zone: zi, index: i})
		}
	}
	slices.SortStableFunc(needs, func(a, b ordered) int {
		if a.plan != b.plan {
			return a.plan - b.plan
		}
		if a.zone != b.zone {
			return a.zone - b.zone
		}
		return a.index - b.index
	})
	order := map[NeedKey]int{}
	var todo []ordered
	missingByFT := map[uuid.UUID]int64{}
	for i, o := range needs {
		order[o.n.Key] = i
		if !inScope(o.n) {
			continue
		}
		if o.missing = missingOf(st, o.n); o.missing > 0 {
			todo = append(todo, o)
			missingByFT[o.n.FunctionTypeID] += int64(o.missing)
		}
	}
	// Scarcity per function type: free serving channels ÷ missing units.
	var allSlots []ChannelKey
	allSlots = append(allSlots, boardSlots...)
	for _, pl := range sn.data.Plans {
		for _, d := range pl.Placements {
			if d.ZoneID != nil {
				allSlots = append(allSlots, roomSlots[[2]uuid.UUID{pl.ID, *d.ZoneID}]...)
			}
		}
	}
	freeByFT := map[uuid.UUID]int64{}
	seen := map[ChannelKey]bool{}
	for _, ch := range allSlots {
		if seen[ch] || st.busy(ch) {
			continue
		}
		seen[ch] = true
		for ft := range st.cat.Served[ch.Kind] {
			if missingByFT[ft] > 0 {
				freeByFT[ft]++
			}
		}
	}
	scarcity := func(ft uuid.UUID) float64 { return float64(freeByFT[ft]) / float64(missingByFT[ft]) }
	slices.SortStableFunc(todo, func(a, b ordered) int {
		sa, sb := scarcity(a.n.FunctionTypeID), scarcity(b.n.FunctionTypeID)
		switch {
		case sa < sb:
			return -1
		case sa > sb:
			return 1
		}
		return 0
	})

	type left struct {
		n                   *Need
		missing, placed     int32
		sawServing, sawFree bool
	}
	var lefts []*left
	for _, o := range todo {
		n := o.n
		out.Needs++
		out.Units += int64(o.missing)
		circuit := st.cat.Circuit[n.FunctionTypeID]
		l := &left{n: n, missing: o.missing}
		for l.placed < l.missing {
			// The reason of a unit left over is what its own trial saw (D417).
			l.sawServing, l.sawFree = false, false
			ok := false
			var at ChannelKey
			if circuit {
				for _, ch := range p.circuits[keyOfCircuit(n)] {
					l.sawServing, l.sawFree = true, true
					if p.try(n, ch) {
						ok, at = true, ch
						break
					}
				}
			}
			if !ok {
				before := len(p.made)
				ok = p.pick(n, roomFor(n), &l.sawServing, &l.sawFree) || p.pick(n, boardFor(n.FunctionTypeID), &l.sawServing, &l.sawFree)
				if ok {
					at = lastChannel(p, n, before)
				}
			}
			if !ok {
				break
			}
			l.placed++
			if circuit {
				p.addCircuit(n, at)
			}
		}
		if l.placed < l.missing {
			lefts = append(lefts, l)
		}
		out.ConnectedUnits += int64(l.placed)
	}

	// Repair: move one connection of this run out of the way (D409). A
	// signature that found no repair finds none until a repair succeeds.
	noRepair := map[needSig]bool{}
	for _, l := range lefts {
		for l.placed < l.missing && !noRepair[sigOf(l.n)] {
			if !p.repair(l.n, roomFor, boardFor) {
				noRepair[sigOf(l.n)] = true
				break
			}
			clear(noRepair)
			l.placed++
			out.ConnectedUnits++
		}
	}
	for _, l := range lefts {
		if l.placed >= l.missing {
			continue
		}
		reason := ReasonLimitsExceeded
		switch {
		case !l.sawServing:
			reason = ReasonNoChannelServes
		case !l.sawFree && p.fitsSomewhereEmpty(l.n, roomFor, boardFor):
			reason = ReasonNoFreeChannel
		}
		n := l.n
		out.Unconnectable = append(out.Unconnectable, Unconnectable{NeedPlanID: n.Key.PlanID, NeedID: n.Key.ID, Units: l.missing - l.placed,
			Reason: reason, Params: map[string]any{"functionTypeKey": st.cat.FunctionKey[n.FunctionTypeID], "label": n.Label}})
	}
	// Listed in need order.
	slices.SortStableFunc(p.made, func(a, b *Conn) int { return order[a.Need] - order[b.Need] })
	slices.SortStableFunc(out.Unconnectable, func(a, b Unconnectable) int {
		return order[NeedKey{a.NeedPlanID, a.NeedID}] - order[NeedKey{b.NeedPlanID, b.NeedID}]
	})
	for _, c := range p.made {
		out.Connections = append(out.Connections, PlannedConnection{NeedPlanID: c.Need.PlanID, NeedID: c.Need.ID, Units: c.Units,
			TargetPlanID: c.Channel.Item.PlanID, TargetItemID: c.Channel.Item.ID, OutputKindID: c.Channel.Kind, ChannelNo: int32(st.noOf(c.Channel, 0))})
	}
	out.Checksum = checksum(sn.conns, out)
	return out, p.made
}

// fitsSomewhereEmpty reports whether one unit of n would fit on some
// serving channel if that channel's item were empty: without one, the need
// is too large for every channel (limits_exceeded, D418), not short of
// free channels.
func (p *planner) fitsSomewhereEmpty(n *Need, roomFor func(*Need) *prefList, boardFor func(uuid.UUID) *prefList) bool {
	for _, ch := range slices.Concat(roomFor(n).chans, boardFor(n.FunctionTypeID).chans) {
		if p.st.fitsEmpty(n, ch) {
			return true
		}
	}
	return false
}

// lastChannel is the channel the last pick used: a new connection or a
// grown one of the need.
func lastChannel(p *planner, n *Need, before int) ChannelKey {
	if len(p.made) > before {
		return p.made[len(p.made)-1].Channel
	}
	// A grown connection: pick only takes free channels, so this does not
	// happen; keep the zero key.
	return ChannelKey{}
}

// blockers are the connections using a channel or one of its base
// channels.
func (p *planner) blockers(ch ChannelKey) []*Conn {
	st := p.st
	sl, ok := st.slot(ch)
	if !ok {
		return nil
	}
	var out []*Conn
	add := func(c *Conn) {
		if !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	for _, c := range st.byChannel[ch] {
		add(c)
	}
	for b := sl.first; b <= sl.last; b++ {
		for other := range st.phys[physKey{ch.Item, sl.cap.OutputKindID, b}] {
			for _, c := range st.byChannel[other] {
				add(c)
			}
		}
	}
	return out
}

// repair places one unit of n on a serving channel that a single
// connection of this run blocks, moving that connection to another free
// channel serving its need (D409). The failure memory is cleared after a
// move (items got lighter).
func (p *planner) repair(n *Need, roomFor func(*Need) *prefList, boardFor func(uuid.UUID) *prefList) bool {
	st := p.st
	// Free channels a blocker's need could move to (the state is restored
	// after every failed attempt, so they are computed once per call).
	freeFor := map[*Need][]ChannelKey{}
	targetsOf := func(bn *Need) []ChannelKey {
		if t, ok := freeFor[bn]; ok {
			return t
		}
		var t []ChannelKey
		for _, ch := range slices.Concat(roomFor(bn).chans, boardFor(bn.FunctionTypeID).chans) {
			if !st.busy(ch) {
				t = append(t, ch)
			}
		}
		freeFor[bn] = t
		return t
	}
	for _, list := range []*prefList{roomFor(n), boardFor(n.FunctionTypeID)} {
		for _, ch := range list.chans {
			if !st.busy(ch) {
				continue
			}
			bs := p.blockers(ch)
			if len(bs) != 1 || !p.run[bs[0].ID] || bs[0].Need == n.Key {
				continue
			}
			b := bs[0]
			bn := st.needs[b.Need]
			if bn == nil || len(targetsOf(bn)) == 0 {
				continue
			}
			from := b.Channel
			st.remove(b)
			c := &Conn{ID: uuid.New(), Need: n.Key, Units: 1, Channel: ch}
			st.add(c)
			if firstError(st.problemsFor(c), c.ID) != nil {
				st.remove(c)
				st.add(b)
				continue
			}
			moved := false
			for _, ch2 := range targetsOf(bn) {
				if ch2 == from || ch2 == ch || st.busy(ch2) {
					continue
				}
				b.Channel = ch2
				st.add(b)
				if firstError(st.problemsFor(b), b.ID) == nil {
					moved = true
					break
				}
				st.remove(b)
			}
			if !moved {
				b.Channel = from
				st.remove(c)
				st.add(b)
				continue
			}
			if m := p.mine[b.Need]; m != nil {
				delete(m, from)
				m[b.Channel] = b
			}
			if p.mine[n.Key] == nil {
				p.mine[n.Key] = map[ChannelKey]*Conn{}
			}
			p.mine[n.Key][ch] = c
			p.made = append(p.made, c)
			p.run[c.ID] = true
			clear(p.failed)
			return true
		}
	}
	return false
}

// checksum identifies the input (existing connections) and the result of a
// preview: apply recomputes it and refuses when it differs.
func checksum(conns []store.Connection, p AutoConnectPreview) string {
	h := sha256.New()
	for _, c := range conns {
		_, _ = fmt.Fprintf(h, "%s|%s|%s|%d|%s|%s|%s|%d;", c.ID, c.NeedPlanID, c.NeedID, c.Units, c.TargetPlanID, c.TargetItemID, c.OutputKindID, c.ChannelNo)
	}
	data, _ := json.Marshal(struct {
		C []PlannedConnection
		U []Unconnectable
	}{p.Connections, p.Unconnectable})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func checkScope(scope AutoConnectScope) error {
	switch scope.Scope {
	case "all", "":
	case "zones":
		if len(scope.ZoneIDs) == 0 {
			return apperr.Invalid("body.zoneIds", "validation.required", "give the zones")
		}
	case "needs":
		if len(scope.NeedIDs) == 0 {
			return apperr.Invalid("body.needIds", "validation.required", "give the needs")
		}
	default:
		return apperr.Invalid("body.scope", "validation.invalid", "all, zones or needs")
	}
	return nil
}

// Preview returns what auto-connect would do.
func (s *Service) Preview(ctx context.Context, versionID uuid.UUID, scope AutoConnectScope) (AutoConnectPreview, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return AutoConnectPreview{}, err
	}
	if err := checkScope(scope); err != nil {
		return AutoConnectPreview{}, err
	}
	sn, err := s.read(ctx, actor, versionID)
	if err != nil {
		return AutoConnectPreview{}, err
	}
	out, _ := plan(sn, scope)
	return out, nil
}

// Apply makes the connections of the preview (pinned = false, one batch)
// unless anything changed since (auto_connect.changed).
func (s *Service) Apply(ctx context.Context, versionID uuid.UUID, in AutoConnectApply) (AutoConnectResult, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return AutoConnectResult{}, err
	}
	if err := checkScope(in.AutoConnectScope); err != nil {
		return AutoConnectResult{}, err
	}
	out := AutoConnectResult{Connections: []Connection{}}
	err = s.write(ctx, actor, versionID, func(tx pgx.Tx, q *store.Queries, sn *snapshot) error {
		p, made := plan(sn, in.AutoConnectScope)
		if p.Checksum != in.ExpectedChecksum {
			return apperr.Conflict("auto_connect.changed", "the version changed since the preview; preview again")
		}
		if len(made) == 0 {
			return nil
		}
		type row struct {
			NeedPlanID   uuid.UUID  `json:"need_plan_id"`
			NeedID       uuid.UUID  `json:"need_id"`
			Units        int32      `json:"units"`
			TargetPlanID uuid.UUID  `json:"target_plan_id"`
			TargetItemID uuid.UUID  `json:"target_item_id"`
			OutputKindID uuid.UUID  `json:"output_kind_id"`
			ChannelNo    int        `json:"channel_no"`
			AltBase      *uuid.UUID `json:"alt_base_output_kind_id"`
			AltGroup     *int32     `json:"alt_group"`
			Ord          int        `json:"ord"`
		}
		rows := make([]row, len(made))
		for i, c := range made {
			base, group := altOf(c.Channel)
			rows[i] = row{c.Need.PlanID, c.Need.ID, c.Units, c.Channel.Item.PlanID, c.Channel.Item.ID, c.Channel.Kind,
				sn.st.noOf(c.Channel, 0), base, group, i}
		}
		data, err := json.Marshal(rows)
		if err != nil {
			return err
		}
		batch := uuid.New()
		if err := q.InsertConnections(ctx, store.InsertConnectionsParams{TenantID: sn.ref.TenantID, VersionID: versionID, BatchID: batch, Rows: data}); err != nil {
			return mapFK(err)
		}
		out.BatchID = &batch
		all, err := q.ListConnections(ctx, versionID)
		if err != nil {
			return err
		}
		for _, c := range all {
			if c.BatchID != nil && *c.BatchID == batch {
				out.Connections = append(out.Connections, connectionOut(c, sn.st))
			}
		}
		return nil
	})
	return out, err
}

// Undo removes the connections still from an auto-connect batch (rows
// changed by hand left it).
func (s *Service) Undo(ctx context.Context, versionID, batchID uuid.UUID) (Removed, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Removed{}, err
	}
	var n int64
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		n, err = q.DeleteBatch(ctx, store.DeleteBatchParams{VersionID: versionID, BatchID: &batchID})
		return err
	})
	return Removed{Removed: n}, err
}
