package wiring

// Zone coverage (D412, D455): how many units of each need, zone and plan are
// connected. One rule for the checks (zones, counts, need_unconnected) and the
// room overview, so their numbers never disagree.

import (
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
)

// needCoverage is a need with its connected units: Connected counts every
// connection (need_unconnected), Good only those without errors (coverage);
// both at most the quantity. ZoneID is the need's zone when that zone exists
// (nil: outside every zone, also for a zone removed meanwhile).
type needCoverage struct {
	Need      plans.WiringNeed
	ZoneID    *uuid.UUID
	Connected int64
	Good      int64
}

// roomCoverage is a zone (ZoneID nil: outside every zone) with its needs.
type roomCoverage struct {
	ZoneID    *uuid.UUID
	Name      string
	ShortName string
	Needs     []needCoverage
	Units     int64
	Good      int64
	Status    string
}

// planCoverage is a floorplan: its rooms in zone order (outside last, only
// with needs) and its needs in need order.
type planCoverage struct {
	PlanID uuid.UUID
	Name   string
	Rooms  []roomCoverage
	Needs  []needCoverage
}

// brokenConnections are the connections with an error (D412).
func brokenConnections(problems []Problem) map[uuid.UUID]bool {
	broken := map[uuid.UUID]bool{}
	for _, p := range problems {
		if p.Severity == SeverityError {
			for _, id := range p.Conns {
				broken[id] = true
			}
		}
	}
	return broken
}

func roomStatus(units, good int64) string {
	switch {
	case units == 0:
		return "none"
	case good >= units:
		return "covered"
	case good > 0:
		return "partial"
	}
	return "missing"
}

// zoneCoverage computes the coverage of every floorplan of a version, in
// plan order.
func zoneCoverage(sn *snapshot, broken map[uuid.UUID]bool) []planCoverage {
	st := sn.st
	var out []planCoverage
	for _, p := range sn.data.Plans {
		if p.Kind != "floorplan" {
			continue
		}
		pc := planCoverage{PlanID: p.ID, Name: p.Name, Rooms: []roomCoverage{}, Needs: []needCoverage{}}
		index := map[uuid.UUID]int{}
		for _, z := range p.Zones {
			id := z.ID
			index[id] = len(pc.Rooms)
			pc.Rooms = append(pc.Rooms, roomCoverage{ZoneID: &id, Name: z.Name, ShortName: z.ShortName, Needs: []needCoverage{}})
		}
		outside := roomCoverage{Needs: []needCoverage{}}
		for _, n := range p.Needs {
			connected, good := int64(0), int64(0)
			for _, c := range st.byNeed[NeedKey{p.ID, n.ID}] {
				connected += int64(c.Units)
				if !broken[c.ID] {
					good += int64(c.Units)
				}
			}
			nc := needCoverage{Need: n, Connected: min(connected, int64(n.Quantity)), Good: min(good, int64(n.Quantity))}
			room := &outside
			if n.ZoneID != nil {
				if i, ok := index[*n.ZoneID]; ok {
					room = &pc.Rooms[i]
					nc.ZoneID = n.ZoneID
				}
			}
			room.Needs = append(room.Needs, nc)
			room.Units += int64(n.Quantity)
			room.Good += nc.Good
			pc.Needs = append(pc.Needs, nc)
		}
		if len(outside.Needs) > 0 {
			pc.Rooms = append(pc.Rooms, outside)
		}
		for i := range pc.Rooms {
			pc.Rooms[i].Status = roomStatus(pc.Rooms[i].Units, pc.Rooms[i].Good)
		}
		out = append(out, pc)
	}
	return out
}
