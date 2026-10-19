package plans

import (
	"testing"

	"github.com/google/uuid"
)

func TestContains(t *testing.T) {
	square := [][2]float64{{0, 0}, {10, 0}, {10, 10}, {0, 10}}
	concave := [][2]float64{{0, 0}, {10, 0}, {10, 10}, {5, 5}, {0, 10}} // a notch at the top
	for _, tc := range []struct {
		pts  [][2]float64
		p    [2]float64
		want bool
	}{
		{square, [2]float64{5, 5}, true},
		{square, [2]float64{0, 0}, true},  // vertex
		{square, [2]float64{10, 3}, true}, // edge
		{square, [2]float64{10.001, 3}, false},
		{square, [2]float64{-1, 5}, false},
		{concave, [2]float64{5, 8}, false}, // in the notch
		{concave, [2]float64{5, 3}, true},
		{concave, [2]float64{7.5, 7.5}, true}, // on the notch edge
	} {
		if got := contains(tc.pts, tc.p); got != tc.want {
			t.Errorf("%v in %v: %v, want %v", tc.p, tc.pts, got, tc.want)
		}
	}
}

func TestZoneOfSmallestWins(t *testing.T) {
	big := PlanZone{ID: uuid.New(), Points: [][2]float64{{0, 0}, {100, 0}, {100, 100}, {0, 100}}}
	small := PlanZone{ID: uuid.New(), Points: [][2]float64{{10, 10}, {20, 10}, {20, 20}, {10, 20}}}
	same := PlanZone{ID: uuid.New(), Points: [][2]float64{{10, 10}, {20, 10}, {20, 20}, {10, 20}}}
	ps := []PlanPlacement{{PlanPlacementInput: PlanPlacementInput{X: 15, Y: 15}}, {PlanPlacementInput: PlanPlacementInput{X: 50, Y: 50}}}
	assignZones([]PlanZone{small, big, same}, ps)
	if ps[0].ZoneID == nil || *ps[0].ZoneID != same.ID { // equal areas: the one drawn last
		t.Errorf("nested: %v", ps[0].ZoneID)
	}
	if ps[1].ZoneID == nil || *ps[1].ZoneID != big.ID {
		t.Errorf("outer: %v", ps[1].ZoneID)
	}
}

func TestNormalizeRotation(t *testing.T) {
	for in, want := range map[float64]float64{0: 0, 360: 0, 720: 0, -90: 270, 450: 90, 359.5: 359.5, -360: 0} {
		if got := normalizeRotation(in); got != want {
			t.Errorf("%v: %v, want %v", in, got, want)
		}
	}
}
