package installation

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

func TestStrips(t *testing.T) {
	mod := func(offset, width float64) *itemRef { return &itemRef{offsetTE: offset, widthTE: width} }
	type span struct{ from, to float64 }
	got := func(ss []strip) []span {
		var out []span
		for _, s := range ss {
			out = append(out, span{s.from, s.to})
		}
		return out
	}
	for _, tc := range []struct {
		name     string
		mods     []*itemRef
		capacity float64
		want     []span
	}{
		{"fits", []*itemRef{mod(0, 4), mod(4, 8)}, 12, []span{{0, 12}}},
		{"free TE stay on the strip", []*itemRef{mod(0, 4)}, 12, []span{{0, 12}}},
		// 16 TE: the modules fit the first 14, the free rest goes on.
		{"free rest continues", []*itemRef{mod(0, 4), mod(4, 8), mod(12, 2)}, 16, []span{{0, 14}, {14, 16}}},
		// A module crossing TE 14 starts the next strip.
		{"split at a module start", []*itemRef{mod(0, 6), mod(6, 6), mod(12, 4), mod(16, 6)}, 24, []span{{0, 12}, {12, 24}}},
		{"long free gap", []*itemRef{mod(0, 2), mod(20, 2)}, 24, []span{{0, 14}, {14, 24}}},
		{"empty row", nil, 12, []span{{0, 12}}},
		{"empty long row", nil, 30, []span{{0, 14}, {14, 28}, {28, 30}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ss := strips(tc.mods, tc.capacity)
			g := got(ss)
			if len(g) != len(tc.want) {
				t.Fatalf("strips %v, want %v", g, tc.want)
			}
			for i := range g {
				if g[i] != tc.want[i] {
					t.Fatalf("strips %v, want %v", g, tc.want)
				}
			}
			for _, s := range ss {
				if s.to-s.from > labelMaxTE+1e-6 {
					t.Errorf("strip %v wider than %d TE", s, labelMaxTE)
				}
			}
		})
	}
	// Strips holding only free TE are not printed; their range is noted.
	type note struct {
		from, to float64
		free     [][2]float64
	}
	for _, tc := range []struct {
		name     string
		mods     []*itemRef
		capacity float64
		want     []note
	}{
		{"free rest noted", []*itemRef{mod(0, 4), mod(4, 8), mod(12, 2)}, 16, []note{{0, 14, [][2]float64{{14, 16}}}}},
		{"long free gap noted", []*itemRef{mod(0, 2), mod(30, 2)}, 32, []note{{0, 14, [][2]float64{{14, 28}}}, {28, 32, nil}}},
		{"free start noted on the next", []*itemRef{mod(20, 2)}, 22, []note{{14, 22, [][2]float64{{0, 14}}}}},
		{"empty long row", nil, 30, []note{{0, 14, [][2]float64{{14, 30}}}}},
		{"split keeps both", []*itemRef{mod(0, 6), mod(6, 6), mod(12, 4), mod(16, 6)}, 24, []note{{0, 12, nil}, {12, 24, nil}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ps := printedStrips(strips(tc.mods, tc.capacity))
			if len(ps) != len(tc.want) {
				t.Fatalf("printed %+v, want %+v", ps, tc.want)
			}
			for i, p := range ps {
				w := tc.want[i]
				if p.from != w.from || p.to != w.to || len(p.free) != len(w.free) {
					t.Fatalf("printed %d: %v–%v free %v, want %+v", i, p.from, p.to, p.free, w)
				}
				for j := range w.free {
					if p.free[j] != w.free[j] {
						t.Fatalf("printed %d free %v, want %v", i, p.free, w.free)
					}
				}
			}
		})
	}
	if l := tr("de").t("teFree", 15, 16); l != "TE 15–16 frei" {
		t.Errorf("free note %q", l)
	}
	// The ruler label of a continued strip.
	if l := tr("en").t("teRange", teNo(14), teNo(24-1)); l != "TE 15–24" {
		t.Errorf("ruler label %q", l)
	}
}

func TestShortNames(t *testing.T) {
	plan := uuid.New()
	var zones []plans.ZoneName
	for _, n := range []string{"Living room", "Kitchen", "Bathroom", "Bath upstairs", "Hall", "Hallway upstairs", "Kids room", "Kids room",
		"WC", "Office"} {
		zones = append(zones, plans.ZoneName{PlanID: plan, ID: uuid.New(), Name: n})
	}
	zones[9].ShortName = "Büro"
	got := shortNames(zones)
	want := []string{"Liv", "Kit", "Bathr", "Bath", "Hall", "Hallw", "Kids room1", "Kids room2", "WC", "Büro"}
	seen := map[string]bool{}
	for i, z := range zones {
		s := got[[2]uuid.UUID{plan, z.ID}]
		if s != want[i] {
			t.Errorf("%q: %q, want %q", z.Name, s, want[i])
		}
		if seen[strings.ToLower(s)] {
			t.Errorf("%q twice", s)
		}
		seen[strings.ToLower(s)] = true
		if len([]rune(s)) > plans.MaxShortNameLength {
			t.Errorf("%q longer than %d", s, plans.MaxShortNameLength)
		}
	}
}

func TestLoadText(t *testing.T) {
	led := uuid.New()
	d := &data{lang: tr("en"), loadTypes: map[uuid.UUID]capabilities.LoadType{led: {ID: led, Name: i18n.Text{"en": "LED"}}}}
	w40, zero := "40", "0"
	for _, tc := range []struct {
		power *string
		load  *uuid.UUID
		want  string
	}{
		{&w40, &led, "3 × 40 W LED"},
		{&w40, nil, "3 × 40 W"},
		{nil, &led, "3 × LED"},
		{nil, nil, "3"},
		{&zero, nil, "3"},
	} {
		if got := d.loadText(&wiring.NeedInfo{PowerW: tc.power, LoadTypeID: tc.load}, 3); got != tc.want {
			t.Errorf("loadText = %q, want %q", got, tc.want)
		}
	}
}
