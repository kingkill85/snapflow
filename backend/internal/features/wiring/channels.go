package wiring

// The wiring view (step 3d frontend): every logical channel of every item
// with its connections, every need with its connected units, and the
// candidates for a connection (the connect pickers). The frontend shows
// these; the rules stay in validity.go (rule 1).

import (
	"context"
	"slices"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// ChannelInfo is one logical channel of an item (D387 numbering).
type ChannelInfo struct {
	OutputKindID  uuid.UUID   `json:"outputKindId"`
	OutputKindKey string      `json:"outputKindKey"`
	ChannelNo     int         `json:"channelNo"`
	Alternative   bool        `json:"alternative" doc:"Made of base channels of another kind (D303)"`
	BaseKindKey   string      `json:"baseKindKey" doc:"The kind of the base channels"`
	BaseFrom      int         `json:"baseFrom" doc:"First base channel"`
	BaseTo        int         `json:"baseTo" doc:"Last base channel"`
	Blocked       bool        `json:"blocked" doc:"No connection of its own, but a base channel is used by another channel"`
	ConnectionIDs []uuid.UUID `json:"connectionIds" doc:"Its connections in creation order"`
}

// ItemInfo is a board module or floorplan device with channels.
type ItemInfo struct {
	PlanID      uuid.UUID     `json:"planId"`
	PlanName    string        `json:"planName"`
	PlanKind    string        `json:"planKind" enum:"floorplan,board"`
	ItemID      uuid.UUID     `json:"itemId"`
	Label       string        `json:"label"`
	ProductName *i18n.Text    `json:"productName" nullable:"true" doc:"null: the variant no longer exists"`
	VariantName *i18n.Text    `json:"variantName" nullable:"true"`
	ZoneID      *uuid.UUID    `json:"zoneId" nullable:"true" doc:"The zone of a floorplan device"`
	Channels    []ChannelInfo `json:"channels" doc:"Output kind order, native channels first, then alternatives"`
}

// NeedInfo is a need with its connected units.
type NeedInfo struct {
	PlanID          uuid.UUID  `json:"planId"`
	PlanName        string     `json:"planName"`
	NeedID          uuid.UUID  `json:"needId"`
	ZoneID          *uuid.UUID `json:"zoneId" nullable:"true" doc:"null: outside every zone"`
	ZoneName        string     `json:"zoneName"`
	Label           string     `json:"label"`
	FunctionTypeID  uuid.UUID  `json:"functionTypeId"`
	FunctionTypeKey string     `json:"functionTypeKey"`
	Quantity        int32      `json:"quantity"`
	ConnectedUnits  int32      `json:"connectedUnits" doc:"Σ units of its connections (may exceed the quantity: a finding)"`
	PowerW          *string    `json:"powerW" nullable:"true" doc:"Per unit, decimal string"`
	LoadTypeID      *uuid.UUID `json:"loadTypeId" nullable:"true" doc:"null for none"`
}

// Wiring is the wiring view of a version.
type Wiring struct {
	Items       []ItemInfo        `json:"items" doc:"Items with channels in plan order (placements, then modules by row and offset)"`
	Needs       []NeedInfo        `json:"needs" doc:"In plan, zone and need order"`
	Connections []Connection      `json:"connections" doc:"In creation order"`
	Can         ConnectionActions `json:"can"`
}

// CandidatesInput asks for the channels a need can go to, or the needs a
// channel can take.
type CandidatesInput struct {
	DisconnectInput
}

// Candidate is a channel for a need (need mode) or a need for a channel
// (channel mode). Units is how many of the need's missing units the channel
// takes without breaking a rule (0 with a problem).
type Candidate struct {
	NeedPlanID   uuid.UUID     `json:"needPlanId"`
	NeedID       uuid.UUID     `json:"needId"`
	TargetPlanID uuid.UUID     `json:"targetPlanId"`
	TargetItemID uuid.UUID     `json:"targetItemId"`
	OutputKindID uuid.UUID     `json:"outputKindId"`
	ChannelNo    int           `json:"channelNo"`
	Units        int32         `json:"units"`
	Free         bool          `json:"free" doc:"The channel holds nothing and no base channel is used"`
	InZone       bool          `json:"inZone" doc:"A device placed in the need's zone"`
	Problem      *CandidateWhy `json:"problem,omitempty" doc:"Why one unit cannot go there"`
}

// CandidateWhy is the first rule a connection would break.
type CandidateWhy struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params"`
}

// Candidates are the candidates of a need or channel.
type Candidates struct {
	Items  []Candidate `json:"items" doc:"Channels serving the need's function type (need mode: in-zone devices first, then boards, then other devices) or needs the channel's kind serves with missing units (channel mode)"`
	Reason string      `json:"reason,omitempty" enum:"complete,no_channel_serves,no_free_channel,limits_exceeded" doc:"Why no candidate fits (absent when one does): complete = nothing missing"`
}

// itemChannels lists the logical channels of an item (D387).
func itemChannels(sn *snapshot, it *Item) []ChannelKey {
	var out []ChannelKey
	for _, k := range sn.facts.kinds {
		out = append(out, kindChannels(it, k.ID)...)
	}
	return out
}

// Wiring returns the wiring view of a version.
func (s *Service) Wiring(ctx context.Context, versionID uuid.UUID) (Wiring, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Wiring{}, err
	}
	sn, err := s.read(ctx, actor, versionID)
	if err != nil {
		return Wiring{}, err
	}
	st := sn.st
	out := Wiring{Items: []ItemInfo{}, Needs: []NeedInfo{}, Connections: make([]Connection, len(sn.conns)),
		Can: ConnectionActions{Update: actor.Can(auth.PermProjectsWrite) && sn.ref.Writable()}}
	for i, c := range sn.conns {
		out.Connections[i] = connectionOut(c, st)
	}
	for _, p := range sn.data.Plans {
		zoneName := map[uuid.UUID]string{}
		zoneIdx := map[uuid.UUID]int{}
		for i, z := range p.Zones {
			zoneName[z.ID], zoneIdx[z.ID] = z.Name, i
		}
		for _, list := range [][]plans.WiringItem{p.Placements, p.Modules} {
			for _, wi := range list {
				it := st.items[ItemKey{p.ID, wi.ID}]
				chs := itemChannels(sn, it)
				if len(chs) == 0 {
					continue
				}
				info := ItemInfo{PlanID: p.ID, PlanName: p.Name, PlanKind: p.Kind, ItemID: wi.ID, Label: it.Label, ZoneID: it.ZoneID,
					Channels: make([]ChannelInfo, 0, len(chs))}
				if wi.VariantID != nil {
					if v, ok := sn.facts.variants[*wi.VariantID]; ok {
						pn, vn := v.ProductName, v.VariantName
						info.ProductName, info.VariantName = &pn, &vn
					}
				}
				for _, ch := range chs {
					sl, _ := st.slot(ch)
					conns := st.byChannel[ch]
					ci := ChannelInfo{OutputKindID: ch.Kind, OutputKindKey: st.cat.KindKey[ch.Kind], ChannelNo: st.noOf(ch, 0),
						Alternative: ch.Alternative(), BaseKindKey: st.cat.KindKey[sl.cap.OutputKindID],
						BaseFrom: sl.first, BaseTo: sl.last, ConnectionIDs: ids(conns)}
					ci.Blocked = len(conns) == 0 && st.busy(ch)
					info.Channels = append(info.Channels, ci)
				}
				out.Items = append(out.Items, info)
			}
		}
		type ordered struct {
			info NeedInfo
			zone int
		}
		var needs []ordered
		for _, wn := range p.Needs {
			n := st.needs[NeedKey{p.ID, wn.ID}]
			info := NeedInfo{PlanID: p.ID, PlanName: p.Name, NeedID: wn.ID, Label: n.Label, FunctionTypeID: n.FunctionTypeID,
				FunctionTypeKey: st.cat.FunctionKey[n.FunctionTypeID], Quantity: n.Quantity, PowerW: wn.PowerW, LoadTypeID: wn.LoadTypeID}
			zi := len(p.Zones)
			if n.ZoneID != nil {
				if v, ok := zoneIdx[*n.ZoneID]; ok {
					zi, info.ZoneID, info.ZoneName = v, n.ZoneID, zoneName[*n.ZoneID]
				}
			}
			for _, c := range st.byNeed[n.Key] {
				info.ConnectedUnits += c.Units
			}
			needs = append(needs, ordered{info, zi})
		}
		slices.SortStableFunc(needs, func(a, b ordered) int { return a.zone - b.zone })
		for _, n := range needs {
			out.Needs = append(out.Needs, n.info)
		}
	}
	return out, nil
}

// tryUnits is the most units (up to max) of need n the channel takes
// without an error, and the first error of one unit. More units never fix
// a broken rule, so the most is found by binary search (D415).
func tryUnits(st *state, n *Need, ch ChannelKey, max int32) (int32, *Problem) {
	c := &Conn{ID: uuid.New(), Need: n.Key, Units: 1, Channel: ch}
	st.add(c)
	defer st.remove(c)
	if p := firstError(st.problemsFor(c), c.ID); p != nil {
		return 0, p
	}
	lo, hi := int32(1), max // lo fits
	for lo < hi {
		mid := lo + (hi-lo+1)/2
		c.Units = mid
		if firstError(st.problemsFor(c), c.ID) == nil {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	c.Units = lo
	return lo, nil
}

func missingOf(st *state, n *Need) int32 {
	have := int32(0)
	for _, c := range st.byNeed[n.Key] {
		have += c.Units
	}
	return n.Quantity - have
}

// Candidates lists where a need can go (need mode) or what a channel can
// take (channel mode), each with the units it takes or the rule it breaks.
func (s *Service) Candidates(ctx context.Context, versionID uuid.UUID, in CandidatesInput) (Candidates, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Candidates{}, err
	}
	needMode := in.NeedPlanID != nil && in.NeedID != nil
	channelMode := in.TargetPlanID != nil && in.TargetItemID != nil && in.OutputKindID != nil && in.ChannelNo != nil
	if needMode == channelMode {
		return Candidates{}, apperr.Invalid("body", "connection.candidates_target", "give a need or a channel")
	}
	sn, err := s.read(ctx, actor, versionID)
	if err != nil {
		return Candidates{}, err
	}
	st := sn.st
	out := Candidates{Items: []Candidate{}}
	add := func(n *Need, ch ChannelKey, missing int32, inZone bool) {
		units, p := tryUnits(st, n, ch, missing)
		c := Candidate{NeedPlanID: n.Key.PlanID, NeedID: n.Key.ID, TargetPlanID: ch.Item.PlanID, TargetItemID: ch.Item.ID,
			OutputKindID: ch.Kind, ChannelNo: st.noOf(ch, 0), Units: units, Free: !st.busy(ch), InZone: inZone}
		if p != nil {
			c.Problem = &CandidateWhy{Code: p.Code, Params: p.Params}
		}
		out.Items = append(out.Items, c)
	}
	if needMode {
		n := st.needs[NeedKey{*in.NeedPlanID, *in.NeedID}]
		if n == nil {
			return Candidates{}, apperr.Invalid("body.needId", "connection.need_not_found", "the need does not exist")
		}
		missing := missingOf(st, n)
		if missing <= 0 {
			out.Reason = "complete"
			return out, nil
		}
		serving := func(it *Item) []ChannelKey {
			var chs []ChannelKey
			for _, ch := range itemChannels(sn, it) {
				if st.cat.Served[ch.Kind][n.FunctionTypeID] {
					chs = append(chs, ch)
				}
			}
			return chs
		}
		// Devices placed in another zone are not offered (D413): a device
		// switches the loads of its own room.
		var room, boards, others []*Item
		for _, p := range sn.data.Plans {
			for _, pl := range p.Placements {
				it := st.items[ItemKey{p.ID, pl.ID}]
				switch {
				case p.ID == n.Key.PlanID && n.ZoneID != nil && it.ZoneID != nil && *it.ZoneID == *n.ZoneID:
					room = append(room, it)
				case it.ZoneID == nil:
					others = append(others, it)
				}
			}
			for _, m := range p.Modules {
				boards = append(boards, st.items[ItemKey{p.ID, m.ID}])
			}
		}
		for i, group := range [][]*Item{room, boards, others} {
			for _, it := range group {
				for _, ch := range serving(it) {
					add(n, ch, missing, i == 0)
				}
			}
		}
	} else {
		ch := st.keyOf(ItemKey{*in.TargetPlanID, *in.TargetItemID}, *in.OutputKindID, int(*in.ChannelNo))
		it := st.items[ch.Item]
		if _, ok := st.slot(ch); !ok || it == nil || !it.HasVariant {
			return Candidates{}, apperr.Invalid("body.channelNo", "connection.channel_not_found", "the channel does not exist")
		}
		if len(st.cat.Served[ch.Kind]) == 0 {
			out.Reason = ReasonNoChannelServes
			return out, nil
		}
		for _, p := range sn.data.Plans {
			for _, wn := range p.Needs {
				n := st.needs[NeedKey{p.ID, wn.ID}]
				if !st.cat.Served[ch.Kind][n.FunctionTypeID] {
					continue
				}
				inZone := !it.Board && ch.Item.PlanID == p.ID && it.ZoneID != nil && n.ZoneID != nil && *it.ZoneID == *n.ZoneID
				if !it.Board && it.ZoneID != nil && !inZone {
					continue // a device in a zone takes only that zone's needs (D413)
				}
				if missing := missingOf(st, n); missing > 0 {
					add(n, ch, missing, inZone)
				}
			}
		}
		if len(out.Items) == 0 {
			out.Reason = "complete"
			return out, nil
		}
	}
	reasonOf(st, &out)
	return out, nil
}

// reasonOf sets the reason when no candidate fits (as auto-connect, D391):
// limits_exceeded when a free channel refuses or no channel would take one
// unit even when empty (D418), else no_free_channel.
func reasonOf(st *state, out *Candidates) {
	if len(out.Items) == 0 {
		out.Reason = ReasonNoChannelServes
		return
	}
	free, fitsEmpty := false, false
	for _, c := range out.Items {
		if c.Problem == nil {
			return
		}
		free = free || c.Free
		if !fitsEmpty {
			ch := st.keyOf(ItemKey{c.TargetPlanID, c.TargetItemID}, c.OutputKindID, c.ChannelNo)
			fitsEmpty = st.fitsEmpty(st.needs[NeedKey{c.NeedPlanID, c.NeedID}], ch)
		}
	}
	out.Reason = ReasonNoFreeChannel
	if free || !fitsEmpty {
		out.Reason = ReasonLimitsExceeded
	}
}

// fitsEmpty reports whether one unit of n would be valid on ch if nothing
// else were connected to ch's item.
func (s *state) fitsEmpty(n *Need, ch ChannelKey) bool {
	if n == nil {
		return false
	}
	e := newState(s.cat, s.needs, s.items)
	c := &Conn{ID: uuid.New(), Need: n.Key, Units: 1, Channel: ch}
	e.add(c)
	return firstError(e.problemsFor(c), c.ID) == nil
}
