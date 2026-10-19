package wiring

// Auto-connect (spec 3d): connects the unconnected units of needs to free
// channels, deterministically, never adding products and never touching
// existing connections.
//
// Order of needs: plan order → zone order (needs outside every zone last)
// → need order → unit. Targets of a need, in this order:
//  1. for a function type that allows circuits: channels that already hold
//     needs of the same plan, zone and function type (existing connections
//     and this run's), in the order they were first used — the circuit is
//     kept per zone and function type;
//  2. free channels of the devices placed in the need's zone on its floorplan
//     (placement order);
//  3. free channels of the boards in plan order → modules by row and offset
//     → output kind order → channel number (native channels before the
//     alternative groups), so a module fills before the next.
//
// A channel is free when it holds no connection and none of its base
// channels is used by another channel (D303). A unit goes to the first
// target where the connection breaks no rule (validity errors; warnings do
// not stop it); several units of a need on one channel are one connection.

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

	// Board slots in target order, and slots of the devices in each zone.
	itemSlots := func(it *Item) []ChannelKey {
		var kinds []uuid.UUID
		for _, k := range sn.facts.kinds {
			if slotCount(it, k.ID) > 0 {
				kinds = append(kinds, k.ID)
			}
		}
		var out []ChannelKey
		for _, k := range kinds {
			for no := 1; no <= slotCount(it, k); no++ {
				out = append(out, ChannelKey{Item: it.Key, Kind: k, No: no})
			}
		}
		return out
	}
	var boardSlots []ChannelKey
	roomSlots := map[[2]uuid.UUID][]ChannelKey{}
	for _, p := range sn.data.Plans {
		for _, m := range p.Modules {
			boardSlots = append(boardSlots, itemSlots(st.items[ItemKey{p.ID, m.ID}])...)
		}
		for _, pl := range p.Placements {
			if pl.ZoneID == nil {
				continue
			}
			k := [2]uuid.UUID{p.ID, *pl.ZoneID}
			roomSlots[k] = append(roomSlots[k], itemSlots(st.items[ItemKey{p.ID, pl.ID}])...)
		}
	}
	// Board slots serving a function type, with a cursor past the leading
	// busy ones (channels only get busier during a run).
	served := map[uuid.UUID][]ChannelKey{}
	cursor := map[uuid.UUID]int{}
	boardFor := func(ft uuid.UUID) []ChannelKey {
		if list, ok := served[ft]; ok {
			return list
		}
		list := []ChannelKey{}
		for _, ch := range boardSlots {
			if st.cat.Served[ch.Kind][ft] {
				list = append(list, ch)
			}
		}
		served[ft] = list
		return list
	}

	// Circuits so far, from existing connections.
	circuits := map[circuitKey][]ChannelKey{}
	keyOf := func(n *Need) circuitKey {
		k := circuitKey{plan: n.Key.PlanID, ft: n.FunctionTypeID}
		if n.ZoneID != nil {
			k.zone = *n.ZoneID
		}
		return k
	}
	addCircuit := func(n *Need, ch ChannelKey) {
		k := keyOf(n)
		if !slices.Contains(circuits[k], ch) {
			circuits[k] = append(circuits[k], ch)
		}
	}
	for _, c := range st.conns {
		if n := st.needs[c.Need]; n != nil && st.cat.Circuit[n.FunctionTypeID] {
			addCircuit(n, c.Channel)
		}
	}

	// Needs in order.
	type ordered struct {
		n                 *Need
		plan, zone, index int
	}
	var needs []ordered
	for pi, p := range sn.data.Plans {
		zoneIdx := map[uuid.UUID]int{}
		for i, z := range p.Zones {
			zoneIdx[z.ID] = i
		}
		for i, wn := range p.Needs {
			n := st.needs[NeedKey{p.ID, wn.ID}]
			zi := len(p.Zones)
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

	var made []*Conn
	for _, o := range needs {
		n := o.n
		if !inScope(n) {
			continue
		}
		have := int32(0)
		for _, c := range st.byNeed[n.Key] {
			have += c.Units
		}
		missing := n.Quantity - have
		if missing <= 0 {
			continue
		}
		out.Needs++
		out.Units += int64(missing)
		circuit := st.cat.Circuit[n.FunctionTypeID]
		sawServing, sawFree := false, false
		// mine: this run's connection of the need per channel.
		mine := map[ChannelKey]*Conn{}
		var last ChannelKey
		try := func(ch ChannelKey) bool {
			last = ch
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
				made = append(made, c)
				return true
			}
			st.remove(c)
			return false
		}
		free := func(ch ChannelKey) bool {
			if !st.cat.Served[ch.Kind][n.FunctionTypeID] {
				return false
			}
			sawServing = true
			if st.busy(ch) {
				return false
			}
			sawFree = true
			return try(ch)
		}
		placed := int32(0)
		for placed < missing {
			ok := false
			if circuit {
				for _, ch := range circuits[keyOf(n)] {
					sawServing, sawFree = true, true
					if try(ch) {
						ok = true
						break
					}
				}
			}
			if !ok && n.ZoneID != nil {
				for _, ch := range roomSlots[[2]uuid.UUID{n.Key.PlanID, *n.ZoneID}] {
					if free(ch) {
						ok = true
						break
					}
				}
			}
			if !ok {
				list := boardFor(n.FunctionTypeID)
				if len(list) > 0 {
					sawServing = true
				}
				i := cursor[n.FunctionTypeID]
				for i < len(list) && st.busy(list[i]) {
					i++
				}
				cursor[n.FunctionTypeID] = i
				for ; i < len(list); i++ {
					if free(list[i]) {
						ok = true
						break
					}
				}
			}
			if !ok {
				break
			}
			placed++
			if circuit {
				addCircuit(n, last)
			}
		}
		out.ConnectedUnits += int64(placed)
		if placed < missing {
			reason := ReasonLimitsExceeded
			switch {
			case !sawServing:
				reason = ReasonNoChannelServes
			case !sawFree:
				reason = ReasonNoFreeChannel
			}
			out.Unconnectable = append(out.Unconnectable, Unconnectable{NeedPlanID: n.Key.PlanID, NeedID: n.Key.ID, Units: missing - placed,
				Reason: reason, Params: map[string]any{"functionTypeKey": st.cat.FunctionKey[n.FunctionTypeID], "label": n.Label}})
		}
	}
	for _, c := range made {
		out.Connections = append(out.Connections, PlannedConnection{NeedPlanID: c.Need.PlanID, NeedID: c.Need.ID, Units: c.Units,
			TargetPlanID: c.Channel.Item.PlanID, TargetItemID: c.Channel.Item.ID, OutputKindID: c.Channel.Kind, ChannelNo: int32(c.Channel.No)})
	}
	out.Checksum = checksum(sn.conns, out)
	return out, made
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
			NeedPlanID   uuid.UUID `json:"need_plan_id"`
			NeedID       uuid.UUID `json:"need_id"`
			Units        int32     `json:"units"`
			TargetPlanID uuid.UUID `json:"target_plan_id"`
			TargetItemID uuid.UUID `json:"target_item_id"`
			OutputKindID uuid.UUID `json:"output_kind_id"`
			ChannelNo    int       `json:"channel_no"`
			Ord          int       `json:"ord"`
		}
		rows := make([]row, len(made))
		for i, c := range made {
			rows[i] = row{c.Need.PlanID, c.Need.ID, c.Units, c.Channel.Item.PlanID, c.Channel.Item.ID, c.Channel.Kind, c.Channel.No, i}
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
				out.Connections = append(out.Connections, connectionOut(c))
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
