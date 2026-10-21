package wiring

// The room overview of the Needs tab (4b-4, D455): every zone of every
// floorplan with its needs and how many of their units are connected,
// computed here because this feature owns connections; needs and zones are
// read through the plans service (WiringData).

import (
	"context"
	"slices"

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

func (c *RoomCounts) add(n RoomNeed) {
	c.Needs++
	c.Units += int64(n.Quantity)
	c.ConnectedUnits += n.ConnectedUnits
	c.sum.Add(n.Quantity, n.PowerW)
}

// done writes the power sum.
func (c *RoomCounts) done() { c.PowerW = c.sum.String() }

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

// buildRooms is the pure part of Rooms: the zone coverage the checks use
// (D412, D455), with the function types named.
func buildRooms(sn *snapshot, ftRef map[uuid.UUID]RoomFunctionType, ftOrder []uuid.UUID, can ConnectionActions) Rooms {
	st := sn.st
	ref := func(id uuid.UUID) RoomFunctionType {
		if f, ok := ftRef[id]; ok {
			return f
		}
		return RoomFunctionType{ID: id, Key: st.cat.FunctionKey[id], Name: i18n.Text{}}
	}
	out := Rooms{VersionID: sn.ref.ID, Plans: []RoomPlan{}, FunctionTypes: []RoomFunctionTotal{}, Can: can}
	byFT := map[uuid.UUID]*RoomCounts{}
	var unlisted []uuid.UUID
	for _, pc := range zoneCoverage(sn, brokenConnections(st.evaluate())) {
		plan := RoomPlan{PlanID: pc.PlanID, Name: pc.Name, Rooms: make([]Room, 0, len(pc.Rooms))}
		for _, rc := range pc.Rooms {
			room := Room{PlanID: pc.PlanID, ZoneID: rc.ZoneID, Name: rc.Name, ShortName: rc.ShortName, Needs: make([]RoomNeed, 0, len(rc.Needs)),
				Units: rc.Units, ConnectedUnits: rc.Good, Status: rc.Status}
			for _, nc := range rc.Needs {
				n := nc.Need
				need := RoomNeed{ID: n.ID, FunctionType: ref(n.FunctionTypeID), Quantity: n.Quantity, PowerW: watts.FormatPtr(n.PowerW), Label: n.Label,
					ConnectedUnits: nc.Good}
				room.Needs = append(room.Needs, need)
				out.Totals.add(need)
				c := byFT[n.FunctionTypeID]
				if c == nil {
					c = &RoomCounts{}
					byFT[n.FunctionTypeID] = c
					if _, ok := ftRef[n.FunctionTypeID]; !ok {
						unlisted = append(unlisted, n.FunctionTypeID)
					}
				}
				c.add(need)
			}
			plan.Rooms = append(plan.Rooms, room)
		}
		out.Plans = append(out.Plans, plan)
	}
	out.Totals.done()
	for _, id := range append(slices.Clone(ftOrder), unlisted...) {
		if c := byFT[id]; c != nil {
			c.done()
			out.FunctionTypes = append(out.FunctionTypes, RoomFunctionTotal{FunctionType: ref(id), Counts: *c})
		}
	}
	return out
}
