package installation

// Channel labels (3e, D424): per board row a label strip at 17.5 mm per TE
// on A4 landscape, one label per module with its position and label and a
// line per connected channel (number, zone abbreviation, need), dashed cut
// lines. A row longer than 14 TE (the 257 mm text width) continues on a
// further strip, split at module starts.

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
)

const (
	labelMMPerTE  = 17.5
	labelMaxTE    = 14
	labelTitlePt  = 7
	labelLinePt   = 6
	labelLineMM   = 2.6
	labelMinRowMM = 15
)

// zoneAbbrev: the zone name's first word, at most 6 characters.
func zoneAbbrev(name string) string {
	f := strings.FieldsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || r == '-' })
	if len(f) == 0 {
		return ""
	}
	r := []rune(f[0])
	if len(r) > 6 {
		r = r[:6]
	}
	return string(r)
}

// labelLines are the channel lines of a module: "3 Liv Ceiling".
func labelLines(d *data, planID, itemID uuid.UUID) []string {
	var out []string
	for _, info := range d.wiring.Items {
		if info.PlanID != planID || info.ItemID != itemID {
			continue
		}
		for _, ch := range info.Channels {
			var names []string
			for _, id := range ch.ConnectionIDs {
				c := connectionByID(d, id)
				if c == nil {
					continue
				}
				if n := d.needByKey[[2]uuid.UUID{c.NeedPlanID, c.NeedID}]; n != nil {
					names = append(names, strings.TrimSpace(zoneAbbrev(n.ZoneName)+" "+d.needName(n)))
				}
			}
			if len(names) > 0 {
				out = append(out, strconv.Itoa(ch.ChannelNo)+" "+strings.Join(names, ", "))
			}
		}
	}
	return out
}

// labels builds the channel labels document.
func labels(d *data, h header) document.Document {
	l := d.lang
	doc := h.document(l, l.t("labelsTitle"))
	doc.Header, doc.CompactHeader = nil, true
	sec := document.Section{Orientation: document.Landscape}
	add := func(b ...document.Block) { sec.Blocks = append(sec.Blocks, b...) }
	add(document.Heading{Level: 1, Text: l.t("labelsTitle") + " – " + h.project.Number + " " + h.project.Name + " " + h.versionName})
	add(document.Paragraph{Runs: []document.Run{{Text: l.t("labelsIntro")}}, Style: document.Muted})
	boards := 0
	for _, p := range d.plans {
		if p.Kind != plans.KindBoard {
			continue
		}
		boards++
		add(document.Heading{Level: 2, Text: p.Name})
		b := d.boards[p.ID]
		for ri, r := range b.Rows {
			var mods []*itemRef
			for _, it := range d.itemByKey {
				if it.planID == p.ID && it.board && it.rowIndex == ri {
					mods = append(mods, it)
				}
			}
			slices.SortFunc(mods, func(a, c *itemRef) int { return posNo(a.position) - posNo(c.position) })
			if len(mods) == 0 {
				continue
			}
			add(document.Paragraph{Runs: []document.Run{{Text: l.t("row", ri+1), Bold: true}}, Style: document.Small})
			for _, strip := range strips(mods, r.CapacityTE) {
				add(stripTable(d, strip), document.Spacer{})
			}
		}
	}
	if boards == 0 {
		add(document.Text(l.t("noBoards")))
	}
	doc.Sections = []document.Section{sec}
	return doc
}

// strip is a part of a row: modules from startTE, at most labelMaxTE wide.
type strip struct {
	startTE, widthTE float64
	mods             []*itemRef
}

// strips splits a row's modules into strips of at most labelMaxTE, at
// module starts; a strip covers its modules from the first one's start
// (the row's start for the first strip).
func strips(mods []*itemRef, capacity float64) []strip {
	var out []strip
	cur := strip{}
	end := func(m *itemRef) float64 { return m.offsetTE + math.Max(m.widthTE, 1) }
	for _, m := range mods {
		if len(cur.mods) > 0 && end(m)-cur.startTE > labelMaxTE {
			out = append(out, cur)
			cur = strip{startTE: m.offsetTE}
		}
		cur.mods = append(cur.mods, m)
		cur.widthTE = end(m) - cur.startTE
	}
	if len(cur.mods) > 0 {
		out = append(out, cur)
	}
	_ = capacity
	return out
}

// stripTable: a column per module and per gap, weighted by TE, the table
// 17.5 mm per TE wide; one row of fixed height.
func stripTable(d *data, s strip) document.Table {
	t := document.Table{CutLines: true, WidthMM: s.widthTE * labelMMPerTE}
	row := document.Row{}
	pos := s.startTE
	lines := 1
	for _, m := range s.mods {
		if gap := m.offsetTE - pos; gap > 0.05 {
			t.Columns = append(t.Columns, document.Column{Weight: gap})
			row.Cells = append(row.Cells, document.Cell{})
		}
		w := math.Max(m.widthTE, 1)
		t.Columns = append(t.Columns, document.Column{Weight: w, Align: document.AlignCenter})
		title := m.position
		if m.label != "" {
			title += " " + m.label
		}
		runs := []document.Run{{Text: title, Bold: true, SizePt: labelTitlePt}}
		ls := labelLines(d, m.planID, m.itemID)
		for _, line := range ls {
			runs = append(runs, document.Run{Text: "\n" + line, SizePt: labelLinePt})
		}
		lines = max(lines, len(ls)+1)
		row.Cells = append(row.Cells, document.Cell{Runs: runs})
		pos = m.offsetTE + w
	}
	t.Rows = []document.Row{row}
	t.RowHeightMM = math.Max(labelMinRowMM, 4+float64(lines)*labelLineMM)
	return t
}
