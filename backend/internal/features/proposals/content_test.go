package proposals

import (
	"context"
	"errors"
	"image"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/semaphore"

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

func cellText(c document.Cell) string {
	var b strings.Builder
	for _, r := range c.Runs {
		b.WriteString(r.Text)
	}
	return b.String()
}

// testBOM: n plans with one zone each; one category per entry of cats with
// a catalog line (2 in the first plan's zone, 1 unzoned) and an add-on line
// in the first category.
func testBOM(n int, cats int) bom.BOM {
	b := bom.BOM{Totals: bom.BOMTotals{Currency: "USD", Rate: "1"}}
	for i := range n {
		b.Plans = append(b.Plans, bom.BOMPlanRef{ID: uuid.New(), Name: "Plan " + itoa(i+1), Zones: []bom.BOMZoneRef{{ID: uuid.New(), Name: "Zone " + itoa(i+1)}}})
	}
	plan, zone := b.Plans[0].ID.String(), b.Plans[0].Zones[0].ID.String()
	g := bom.BOMGroup{Kind: "productType", ProductType: &bom.NullableSnapshotProductType{SnapshotProductType: bom.SnapshotProductType{ID: uuid.New(), Name: i18n.Text{"en": "Zigbee"}}}, Subtotal: "0.00"}
	for c := range cats {
		cat := bom.BOMCategoryGroup{Category: bom.SnapshotCategory{ID: uuid.New(), Name: i18n.Text{"en": "Cat " + itoa(c+1)}}, Subtotal: "0.00"}
		ln := bom.BOMLine{Key: uuid.NewString(), Kind: bom.KindCatalog, Quantity: 3, UnitPrice: "1.00", Total: "3.00",
			Snapshot:   &bom.NullableItemSnapshot{ItemSnapshot: bom.ItemSnapshot{ProductName: i18n.Text{"en": "Device"}}},
			Quantities: bom.LineQuantities{Plans: map[string]int64{plan: 3}, Zones: map[string]int64{zone: 2}, Unzoned: map[string]int64{plan: 1}}}
		b.Lines = append(b.Lines, ln)
		cat.Lines = append(cat.Lines, ln.Key)
		if c == 0 {
			add := bom.BOMLine{Key: uuid.NewString(), Kind: bom.KindAddOn, Quantity: 3, UnitPrice: "1.00", Total: "3.00",
				Snapshot:   &bom.NullableItemSnapshot{ItemSnapshot: bom.ItemSnapshot{ProductName: i18n.Text{"en": "Battery"}}},
				Quantities: bom.LineQuantities{Plans: map[string]int64{plan: 3}, Zones: map[string]int64{zone: 2}, Unzoned: map[string]int64{plan: 1}}}
			b.Lines = append(b.Lines, add)
			cat.Lines = append(cat.Lines, add.Key)
		}
		g.Categories = append(g.Categories, cat)
	}
	b.Groups = []bom.BOMGroup{g}
	// Every plan has a quantity (plan columns are for plans with one).
	for _, p := range b.Plans[1:] {
		for i := range b.Lines {
			b.Lines[i].Quantities.Plans[p.ID.String()] = 1
		}
	}
	return b
}

func TestPlanColumnsLeaveOutPlansWithoutQuantities(t *testing.T) {
	// A split document: the third plan has none of its devices.
	b := testBOM(3, 1)
	for i := range b.Lines {
		delete(b.Lines[i].Quantities.Plans, b.Plans[2].ID.String())
	}
	c := content{lang: "en", bom: b}
	if head := c.bomTable().Rows[0].Cells; len(head) != 7 {
		t.Errorf("%d columns, want 7 (P1 and P2 only)", len(head))
	}
}

func TestZoneTableLongFormat(t *testing.T) {
	// 6 categories and 6 zones: a zone row with its categories below.
	b := testBOM(1, 6)
	p := &b.Plans[0]
	zone := p.Zones[0].ID.String()
	for i := 1; i < 6; i++ {
		z := uuid.New()
		p.Zones = append(p.Zones, bom.BOMZoneRef{ID: z, Name: "Zone x" + itoa(i)})
		for j := range b.Lines {
			b.Lines[j].Quantities.Zones[z.String()] = b.Lines[j].Quantities.Zones[zone]
		}
	}
	tbl := content{lang: "en", bom: b}.zoneTables()[0].(document.Table)
	if len(tbl.Columns) != 2 || tbl.Rows[1].Kind != document.SubgroupRow || cellText(tbl.Rows[1].Cells[1]) != "12" || cellText(tbl.Rows[2].Cells[0]) != "Cat 1" {
		t.Errorf("long zone table: %d columns, rows %+v", len(tbl.Columns), tbl.Rows[:3])
	}
}

func TestPlanColumns(t *testing.T) {
	for _, tc := range []struct {
		plans   int
		columns bool
	}{{1, false}, {2, true}, {5, true}, {6, false}} {
		c := content{lang: "de", bom: testBOM(tc.plans, 1)}
		head := c.bomTable().Rows[0].Cells
		want := 5 // Pos., description, quantity, unit price, total
		if tc.columns {
			want += tc.plans
		}
		if len(head) != want {
			t.Errorf("%d plans: %d columns, want %d", tc.plans, len(head), want)
		}
		if tc.columns && (cellText(head[2]) != "P1" || cellText(head[1+tc.plans]) != "P"+itoa(tc.plans)) {
			t.Errorf("%d plans: plan headers %q … %q", tc.plans, cellText(head[2]), cellText(head[1+tc.plans]))
		}
		// The legend maps the short headers to the plans' names.
		doc := c.build()
		found := false
		for _, b := range doc.Sections[0].Blocks {
			if p, ok := b.(document.Paragraph); ok && strings.Contains(cellText(document.Cell{Runs: p.Runs}), "P1: Plan 1") {
				found = true
			}
		}
		if found != tc.columns {
			t.Errorf("%d plans: plan column legend %v", tc.plans, found)
		}
	}
}

func TestZoneTables(t *testing.T) {
	// Add-ons are not counted (2 in the zone, 1 unzoned per category).
	c := content{lang: "en", bom: testBOM(1, 2)}
	zones := c.zoneTables()
	if len(zones) != 1 {
		t.Fatalf("%d zone tables", len(zones))
	}
	tbl := zones[0].(document.Table)
	if len(tbl.Rows) != 3 || cellText(tbl.Rows[1].Cells[1]) != "2" || cellText(tbl.Rows[2].Cells[0]) != "No zone" || cellText(tbl.Rows[2].Cells[1]) != "1" {
		t.Errorf("zone table %+v", tbl.Rows)
	}
	// More than 5 categories: categories as rows, zones as columns.
	c = content{lang: "en", bom: testBOM(1, 6)}
	tbl = c.zoneTables()[0].(document.Table)
	if len(tbl.Rows) != 7 || len(tbl.Columns) != 3 || cellText(tbl.Rows[0].Cells[1]) != "Zone 1" || cellText(tbl.Rows[1].Cells[0]) != "Cat 1" || cellText(tbl.Rows[1].Cells[1]) != "2" {
		t.Errorf("transposed zone table %+v", tbl.Rows)
	}
}

func TestNumberFormat(t *testing.T) {
	for _, tc := range []struct{ lang, in, want string }{
		{"en", "1234.50", "1,234.50"}, {"de", "1234.50", "1.234,50"},
		{"en", "-1234567.89", "−1,234,567.89"}, {"de", "-1234567.89", "−1.234.567,89"},
		{"de", "-0.50", "−0,50"}, {"en", "123", "123"}, {"de", "1000", "1.000"},
	} {
		if got := tr(tc.lang).number(tc.in); got != tc.want {
			t.Errorf("%s %s: %s, want %s", tc.lang, tc.in, got, tc.want)
		}
	}
	if got := tr("de").money("-25.00", "EUR"); got != "−25,00 EUR" {
		t.Errorf("money %s", got)
	}
}

// The plan legend counts new devices; existing ones apart.
func TestPlanLegend(t *testing.T) {
	variant := uuid.New()
	snaps := map[uuid.UUID]bom.VariantSnapshot{variant: {VariantID: variant, ProductType: bom.SnapshotProductType{ID: uuid.New(), Name: i18n.Text{"en": "Zigbee"}, Color: "#ff0000"}}}
	pl := func(existing bool) plans.PlanPlacement {
		return plans.PlanPlacement{PlanPlacementInput: plans.PlanPlacementInput{VariantID: &variant, X: 50, Y: 50, Width: 10, Height: 10, Existing: existing}}
	}
	p := plans.DocumentPlan{Name: "EG", Width: 400, Height: 200, Placements: []plans.PlanPlacement{pl(false), pl(false), pl(true)}}
	// The background was scaled down to half; coordinates refer to 400 × 200.
	page, ok, err := renderPlan(p, image.NewRGBA(image.Rect(0, 0, 200, 100)), snaps, nil, nil, "de")
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if page.image.width != 400 || page.image.height != 200 {
		t.Errorf("rendered %d × %d", page.image.width, page.image.height)
	}
	sec := content{lang: "de"}.planSection(page)
	legend := sec.Blocks[len(sec.Blocks)-1].(document.Paragraph)
	if txt := cellText(document.Cell{Runs: legend.Runs}); !strings.Contains(txt, "Zigbee (2 + 1 vorhanden)") {
		t.Errorf("legend %q", txt)
	}
}

// A full generation queue answers 503 server.busy after a short wait.
func TestBusy(t *testing.T) {
	old := generationWait
	generationWait = 50 * time.Millisecond
	defer func() { generationWait = old }()
	s := &Service{generating: semaphore.NewWeighted(1)}
	if err := s.acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := s.acquire(context.Background())
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Status != http.StatusServiceUnavailable || ae.Code != "server.busy" {
		t.Errorf("busy: %v", err)
	}
	s.generating.Release(1)
	if err := s.acquire(context.Background()); err != nil {
		t.Errorf("after release: %v", err)
	}
}

func TestManualLineNotesAndModelNumbers(t *testing.T) {
	b := testBOM(1, 1)
	variant := uuid.New()
	b.Lines[0].Key = variant.String()
	b.Groups[0].Categories[0].Lines[0] = variant.String()
	b.Lines[0].Snapshot.ModelNumber, b.Lines[0].Snapshot.SKU = "ZB-DIM-200", "A-1"
	free := uuid.New()
	b.Lines = append(b.Lines, bom.BOMLine{Key: free.String(), Kind: bom.KindFreeText, Name: "Cable", Quantity: 1, UnitPrice: "1.00", Total: "1.00"})
	b.Groups = append(b.Groups, bom.BOMGroup{Kind: "freeText", Subtotal: "1.00", Lines: []string{free.String()}})
	b.ManualLines = []bom.ManualLine{{ID: uuid.New(), VariantID: &variant, Note: "behind the TV"}, {ID: free, Note: "10 m"}}
	rows := content{lang: "en", bom: b}.bomTable().Rows
	var device, cable string
	var detail document.Run
	for _, r := range rows {
		switch txt := cellText(r.Cells[1]); {
		case strings.HasPrefix(txt, "Device"):
			device, detail = txt, r.Cells[1].Runs[1]
		case strings.HasPrefix(txt, "Cable"):
			cable = txt
		}
	}
	if !strings.HasSuffix(device, "\nbehind the TV") || !strings.HasSuffix(cable, "\n10 m") {
		t.Errorf("notes: %q, %q", device, cable)
	}
	if !detail.NoBreakHyphens || !strings.Contains(detail.Text, "ZB-DIM-200") {
		t.Errorf("model number run: %+v", detail)
	}
}
