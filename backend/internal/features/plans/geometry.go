package plans

import (
	"math"

	"github.com/google/uuid"
)

// polygonArea is the shoelace area of a polygon (absolute, any winding).
func polygonArea(pts [][2]float64) float64 {
	var a float64
	for i := range pts {
		j := (i + 1) % len(pts)
		a += pts[i][0]*pts[j][1] - pts[j][0]*pts[i][1]
	}
	return math.Abs(a) / 2
}

// onSegment reports whether p lies on the segment a-b (within a tiny
// tolerance for floating point).
func onSegment(p, a, b [2]float64) bool {
	const eps = 1e-9
	cross := (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0])
	scale := math.Max(1, math.Hypot(b[0]-a[0], b[1]-a[1]))
	if math.Abs(cross) > eps*scale {
		return false
	}
	return p[0] >= math.Min(a[0], b[0])-eps && p[0] <= math.Max(a[0], b[0])+eps &&
		p[1] >= math.Min(a[1], b[1])-eps && p[1] <= math.Max(a[1], b[1])+eps
}

// contains reports whether p is inside the polygon or on its boundary (ray
// casting; a point on an edge or vertex counts as inside, so a device on a
// wall line belongs to the room).
func contains(pts [][2]float64, p [2]float64) bool {
	inside := false
	for i, j := 0, len(pts)-1; i < len(pts); j, i = i, i+1 {
		a, b := pts[i], pts[j]
		if onSegment(p, a, b) {
			return true
		}
		if (a[1] > p[1]) != (b[1] > p[1]) {
			x := (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1]) + a[0]
			if p[0] < x {
				inside = !inside
			}
		}
	}
	return inside
}

// zoneOf returns the smallest zone (by area) containing p; of zones of the
// same area the one drawn last (on top) wins. nil if none contains p.
func zoneOf(zones []PlanZone, areas []float64, p [2]float64) *uuid.UUID {
	best := -1
	for i, z := range zones {
		if !contains(z.Points, p) {
			continue
		}
		if best < 0 || areas[i] <= areas[best] {
			best = i
		}
	}
	if best < 0 {
		return nil
	}
	id := zones[best].ID
	return &id
}

// assignZones sets the zone of every placement from its centre.
func assignZones(zones []PlanZone, placements []PlanPlacement) {
	areas := make([]float64, len(zones))
	for i, z := range zones {
		areas[i] = polygonArea(z.Points)
	}
	for i := range placements {
		placements[i].ZoneID = zoneOf(zones, areas, [2]float64{placements[i].X, placements[i].Y})
	}
}

// normalizeRotation maps degrees to [0, 360) (360 is 0).
func normalizeRotation(r float64) float64 {
	r = math.Mod(r, 360)
	if r < 0 {
		r += 360
	}
	if r >= 360 || r == 0 { // -1e-18 + 360 rounds to 360; -0 is 0
		r = 0
	}
	return r
}

func finite(xs ...float64) bool {
	for _, x := range xs {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return false
		}
	}
	return true
}
