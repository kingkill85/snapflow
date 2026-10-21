package wiring

// The room overview of the Needs tab (4b-4, D455): every zone of every
// floorplan with its needs and how many of their units are connected,
// computed here because this feature owns connections; needs and zones are
// read through the plans service (WiringData).

import (
	"context"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/watts"
)

// RoomFunctionType names the function type of a need.
type RoomFunctionType struct {
	ID   uuid.UUID `json:"id"`
	Key  string    `json:"key"`
	Name i18n.Text `json:"name"`
}

// RoomNeed is one need of a room with its connected units.
type RoomNeed struct {
	ID             uuid.UUID        `json:"id"`
	FunctionType   RoomFunctionType `json:"functionType"`
	Quantity       int32            `json:"quantity"`
	PowerW         *string          `json:"powerW" nullable:"true" doc:"Power per unit in W, a decimal string with 2 decimals; null for unknown" example:"7.50"`
	Label          string           `json:"label"`
	ConnectedUnits int64            `json:"connectedUnits" doc:"Units connected without errors, at most the quantity"`
}

// Room is a zone of a floorplan (zoneId null: the needs outside every zone
// of the plan, listed last and only when there are any).
type Room struct {
	PlanID         uuid.UUID  `json:"planId"`
	ZoneID         *uuid.UUID `json:"zoneId" nullable:"true" doc:"null: needs outside every zone"`
	Name           string     `json:"name" doc:"The zone's name; empty outside every zone"`
	ShortName      string     `json:"shortName" doc:"The zone's short name as entered; empty when none is set"`
	Needs          []RoomNeed `json:"needs" doc:"In need order"`
	Units          int64      `json:"units" doc:"Sum of the needs' quantities"`
	ConnectedUnits int64      `json:"connectedUnits" doc:"Connected units without errors, each need counted up to its quantity"`
	Status         string     `json:"status" enum:"covered,partial,missing,none" doc:"covered: every unit connected; partial: some; missing: none; none: the zone has no needs"`
}

// RoomPlan is a floorplan with its rooms in zone order.
type RoomPlan struct {
	PlanID uuid.UUID `json:"planId"`
	Name   string    `json:"name"`
	Rooms  []Room    `json:"rooms"`
}

// RoomCounts add up needs, units, connected units and power.
type RoomCounts struct {
	Needs          int64  `json:"needs" doc:"Number of needs"`
	Units          int64  `json:"units"`
	ConnectedUnits int64  `json:"connectedUnits"`
	PowerW         string `json:"powerW" doc:"Sum of quantity × power per unit of the needs with a power, a decimal string with 2 decimals" example:"420.50"`
	sum            watts.Sum
}

// RoomFunctionTotal is the counts of one function type.
type RoomFunctionTotal struct {
	FunctionType RoomFunctionType `json:"functionType"`
	Counts       RoomCounts       `json:"counts"`
}

// Rooms is the room overview of a version.
type Rooms struct {
	VersionID     uuid.UUID           `json:"versionId"`
	Plans         []RoomPlan          `json:"plans" doc:"Every floorplan in plan order"`
	Totals        RoomCounts          `json:"totals"`
	FunctionTypes []RoomFunctionTotal `json:"functionTypes" doc:"Counts per function type, by key"`
	Can           ConnectionActions   `json:"can"`
}

func newCounts() RoomCounts { return RoomCounts{PowerW: watts.Sum{}.String()} }

func (c *RoomCounts) add(n RoomNeed) {
	c.Needs++
	c.Units += int64(n.Quantity)
	c.ConnectedUnits += n.ConnectedUnits
	c.sum.Add(n.Quantity, n.PowerW)
	c.PowerW = c.sum.String()
}

func roomStatus(units, connected int64) string {
	switch {
	case units == 0:
		return "none"
	case connected >= units:
		return "covered"
	case connected > 0:
		return "partial"
	}
	return "missing"
}

// Rooms returns the room overview of a version (projects.read).
func (s *Service) Rooms(ctx context.Context, versionID uuid.UUID) (Rooms, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Rooms{}, err
	}
	sn, err := s.read(ctx, actor, versionID)
	if err != nil {
		return Rooms{}, err
	}
	fts, err := s.functionTypes.List(ctx)
	if err != nil {
		return Rooms{}, err
	}
	ftRef := map[uuid.UUID]RoomFunctionType{}
	order := make([]uuid.UUID, 0, len(fts))
	for _, f := range fts {
		ftRef[f.ID] = RoomFunctionType{ID: f.ID, Key: f.Key, Name: f.Name}
		order = append(order, f.ID)
	}
	return buildRooms(sn, ftRef, order, ConnectionActions{Update: actor.Can(auth.PermProjectsWrite) && sn.ref.Writable()}), nil
}

// buildRooms is the pure part of Rooms. Connected units count like the
// zone coverage of the checks (D412): only connections without errors, each
// need up to its quantity (circuits and partial units add their units).
func buildRooms(sn *snapshot, ftRef map[uuid.UUID]RoomFunctionType, ftOrder []uuid.UUID, can ConnectionActions) Rooms {
	st := sn.st
	broken := map[uuid.UUID]bool{}
	for _, p := range st.evaluate() {
		if p.Severity == SeverityError {
			for _, id := range p.Conns {
				broken[id] = true
			}
		}
	}
	out := Rooms{VersionID: sn.ref.ID, Plans: []RoomPlan{}, Totals: newCounts(), FunctionTypes: []RoomFunctionTotal{}, Can: can}
	byFT := map[uuid.UUID]*RoomCounts{}
	for _, p := range sn.data.Plans {
		if p.Kind != "floorplan" {
			continue
		}
		plan := RoomPlan{PlanID: p.ID, Name: p.Name, Rooms: []Room{}}
		index := map[uuid.UUID]int{}
		for _, z := range p.Zones {
			id := z.ID
			index[id] = len(plan.Rooms)
			plan.Rooms = append(plan.Rooms, Room{PlanID: p.ID, ZoneID: &id, Name: z.Name, ShortName: z.ShortName, Needs: []RoomNeed{}})
		}
		outside := Room{PlanID: p.ID, Needs: []RoomNeed{}}
		for _, n := range p.Needs {
			good := int64(0)
			for _, c := range st.byNeed[NeedKey{p.ID, n.ID}] {
				if !broken[c.ID] {
					good += int64(c.Units)
				}
			}
			ft, ok := ftRef[n.FunctionTypeID]
			if !ok {
				ft = RoomFunctionType{ID: n.FunctionTypeID, Key: st.cat.FunctionKey[n.FunctionTypeID], Name: i18n.Text{}}
			}
			need := RoomNeed{ID: n.ID, FunctionType: ft, Quantity: n.Quantity, PowerW: watts.FormatPtr(n.PowerW), Label: n.Label,
				ConnectedUnits: min(good, int64(n.Quantity))}
			room := &outside
			// A need of a zone removed meanwhile counts as outside.
			if n.ZoneID != nil {
				if i, ok := index[*n.ZoneID]; ok {
					room = &plan.Rooms[i]
				}
			}
			room.Needs = append(room.Needs, need)
			room.Units += int64(n.Quantity)
			room.ConnectedUnits += need.ConnectedUnits
			out.Totals.add(need)
			if byFT[n.FunctionTypeID] == nil {
				c := newCounts()
				byFT[n.FunctionTypeID] = &c
			}
			byFT[n.FunctionTypeID].add(need)
		}
		if len(outside.Needs) > 0 {
			plan.Rooms = append(plan.Rooms, outside)
		}
		for i := range plan.Rooms {
			r := &plan.Rooms[i]
			r.Status = roomStatus(r.Units, r.ConnectedUnits)
		}
		out.Plans = append(out.Plans, plan)
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range ftOrder {
		if c := byFT[id]; c != nil {
			seen[id] = true
			out.FunctionTypes = append(out.FunctionTypes, RoomFunctionTotal{FunctionType: ftRef[id], Counts: *c})
		}
	}
	for _, p := range sn.data.Plans {
		for _, n := range p.Needs {
			if c := byFT[n.FunctionTypeID]; c != nil && !seen[n.FunctionTypeID] {
				seen[n.FunctionTypeID] = true
				ft := RoomFunctionType{ID: n.FunctionTypeID, Key: st.cat.FunctionKey[n.FunctionTypeID], Name: i18n.Text{}}
				out.FunctionTypes = append(out.FunctionTypes, RoomFunctionTotal{FunctionType: ft, Counts: *c})
			}
		}
	}
	return out
}
