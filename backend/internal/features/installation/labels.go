package installation

// Channel labels (3e, D424 as amended by the 3e review): per board row one
// strip spanning the row's capacity (free TE as empty cells) at 17.5 mm per
// TE and a fixed height of 15 mm. Above the strip, outside the cut area:
// the board, the row and a TE ruler. A module's cell has a top band with
// its position and label and a bottom band with one sub-column per
// physical channel: the channel number and up to two lines (zone short
// name, need). A pair of channels used as one alternative channel (two
// relays as a blind output) is one merged sub-cell "1+2"; a free channel
// shows "–"; sub-columns narrower than 8 mm turn their text by 90°. A row
// longer than 14 TE (the 257 mm text width) continues on further strips,
// split at module boundaries ("TE 15–24", "→" marks).

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
)

const (
	// labelMMPerTE is the pitch of a module width (TE); constant for now,
	// later an option per board.
	labelMMPerTE = 17.5
	// labelMaxTE is the most TE on one strip (257 mm text width).
	labelMaxTE = 14
	// The strip is 15 mm high: a 5 mm top band and a 10 mm bottom band.
	labelTopMM    = 5
	labelBottomMM = 10
	labelRulerMM  = 3
	labelTitlePt  = 7.5
	labelNoPt     = 6
	labelTextPt   = 7
	labelRulerPt  = 5
	labelScalePct = 88 // condensed text
	labelMarginMM = 0.4
	// labelVerticalMM: sub-columns narrower than this turn their text.
	labelVerticalMM = 8
	// shortNameMin is the shortest derived zone short name.
	shortNameMin = 3
)

// shortNames derives the zone short names of a project: the zone's own
// short name, else the shortest prefix of its name (at least 3 characters)
// that no other zone name of the project starts with, at most 12
// characters; zones whose names allow no unique prefix get a digit (Bath1,
// Bath2).
func shortNames(zones []plans.ZoneName) map[[2]uuid.UUID]string {
	norm := func(s string) []rune { return []rune(strings.Join(strings.Fields(s), " ")) }
	prefix := func(r []rune, k int) string {
		return strings.TrimRightFunc(string(r[:min(k, len(r))]), unicode.IsSpace)
	}
	names := make([][]rune, len(zones))
	for i, z := range zones {
		names[i] = norm(z.Name)
	}
	out := map[[2]uuid.UUID]string{}
	base := make([]string, len(zones))
	tied := make([]bool, len(zones))
	for i, z := range zones {
		key := [2]uuid.UUID{z.PlanID, z.ID}
		if s := strings.TrimSpace(z.ShortName); s != "" {
			out[key] = s
			continue
		}
		r := names[i]
		found := ""
		for k := shortNameMin; k <= min(len(r), plans.MaxShortNameLength); k++ {
			p := strings.ToLower(prefix(r, k))
			unique := true
			for j, o := range names {
				// A prefix must differ from the other names' prefixes of
				// the same length; the whole name only from the other
				// whole names ("Hall" next to "Hallway": Hall, Hallw).
				other := strings.ToLower(prefix(o, k))
				if k == len(r) {
					other = strings.ToLower(string(o))
				}
				if j != i && other == p {
					unique = false
					break
				}
			}
			if unique {
				found = prefix(r, k)
				break
			}
		}
		if found == "" && len(r) < shortNameMin && len(r) > 0 {
			// A name shorter than 3 characters is its own short name when
			// no other zone has it.
			if !slices.ContainsFunc(names[:i], func(o []rune) bool { return strings.EqualFold(string(o), string(r)) }) &&
				!slices.ContainsFunc(names[i+1:], func(o []rune) bool { return strings.EqualFold(string(o), string(r)) }) {
				found = string(r)
			}
		}
		if found != "" {
			out[key] = found
			continue
		}
		base[i] = prefix(r, max(shortNameMin, min(len(r), plans.MaxShortNameLength-1)))
		tied[i] = true
	}
	// Ties: the same base, numbered in zone order.
	count := map[string]int{}
	for i, z := range zones {
		if !tied[i] {
			continue
		}
		b := strings.ToLower(base[i])
		count[b]++
		out[[2]uuid.UUID{z.PlanID, z.ID}] = base[i] + strconv.Itoa(count[b])
	}
	return out
}

// zoneShort is a need's zone short name ("" outside every zone).
func (d *data) zoneShort(n *wiring.NeedInfo) string {
	if n.ZoneID == nil {
		return ""
	}
	if s, ok := d.zoneShorts[[2]uuid.UUID{n.PlanID, *n.ZoneID}]; ok {
		return s
	}
	return n.ZoneName
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
		b := d.boards[p.ID]
		for ri, r := range b.Rows {
			var mods []*itemRef
			for _, it := range d.itemByKey {
				if it.planID == p.ID && it.board && it.rowIndex == ri {
					mods = append(mods, it)
				}
			}
			slices.SortFunc(mods, func(a, c *itemRef) int { return posNo(a.position) - posNo(c.position) })
			ss := printedStrips(strips(mods, r.CapacityTE))
			for i, s := range ss {
				title := p.Name + " · " + l.t("row", ri+1) + " · " + l.t("teRange", teNo(s.from), teNo(s.to-1))
				for _, f := range s.free {
					title += " · " + l.t("teFree", teNo(f[0]), teNo(f[1]-1))
				}
				if i > 0 {
					title = "→ " + title
				}
				if i < len(ss)-1 {
					title += " →"
				}
				add(document.Paragraph{Runs: []document.Run{{Text: title, Bold: true, SizePt: labelTitlePt}}, KeepWithNext: true},
					stripTable(d, s.strip), document.Spacer{})
			}
		}
	}
	if boards == 0 {
		add(document.Text(l.t("noBoards")))
	}
	doc.Sections = []document.Section{sec}
	return doc
}

// teNo is the 1-based number of the TE starting at x.
func teNo(x float64) int { return int(math.Floor(x+1e-6)) + 1 }

// strip is a part of a row from TE from to TE to (exclusive).
type strip struct {
	from, to float64
	mods     []*itemRef
}

func modEnd(m *itemRef) float64 { return m.offsetTE + math.Max(m.widthTE, 1) }

// strips splits a row into strips of at most labelMaxTE: at module starts,
// free space after the last module at whole labelMaxTE. The strips cover
// the row's capacity (and modules beyond it).
func strips(mods []*itemRef, capacity float64) []strip {
	var out []strip
	cur := strip{}
	flush := func(to float64) {
		cur.to = to
		out = append(out, cur)
		cur = strip{from: to}
	}
	for _, m := range mods {
		// A long free gap before the module.
		for m.offsetTE-cur.from > labelMaxTE+1e-6 {
			flush(cur.from + labelMaxTE)
		}
		if modEnd(m)-cur.from > labelMaxTE+1e-6 && m.offsetTE > cur.from+1e-6 {
			flush(m.offsetTE)
		}
		cur.mods = append(cur.mods, m)
	}
	end := capacity
	last := cur.from
	for _, m := range cur.mods {
		last = math.Max(last, modEnd(m))
	}
	end = math.Max(end, last)
	for end-cur.from > labelMaxTE+1e-6 {
		flush(math.Max(cur.from+labelMaxTE, last))
		last = cur.from
	}
	if end > cur.from+1e-6 || len(out) == 0 {
		flush(math.Max(end, cur.from+1))
	}
	return out
}

// printed is a strip to print with the free TE ranges of the strips left
// out next to it.
type printed struct {
	strip
	free [][2]float64
}

// printedStrips leaves out strips holding only free TE (nothing to label)
// and notes their range on the previous printed strip ("TE 15–16 free"),
// on the next one when none is before. A row without modules prints its
// first strip.
func printedStrips(ss []strip) []printed {
	var out []printed
	var pending [][2]float64
	note := func(free *[][2]float64, from, to float64) {
		if n := len(*free); n > 0 && math.Abs((*free)[n-1][1]-from) < 1e-6 {
			(*free)[n-1][1] = to
			return
		}
		*free = append(*free, [2]float64{from, to})
	}
	for _, s := range ss {
		switch {
		case len(s.mods) > 0 || (len(out) == 0 && len(pending) == 0 && !hasMods(ss)):
			out = append(out, printed{strip: s, free: pending})
			pending = nil
		case len(out) > 0:
			note(&out[len(out)-1].free, s.from, s.to)
		default:
			note(&pending, s.from, s.to)
		}
	}
	return out
}

func hasMods(ss []strip) bool {
	for _, s := range ss {
		if len(s.mods) > 0 {
			return true
		}
	}
	return false
}

// subCell is a bottom-band cell of a module: one or more physical
// channels.
type subCell struct {
	from, to float64 // TE
	no       string
	lines    []string
	free     bool
}

// subCells are a module's bottom-band cells: one per native channel, a
// used alternative channel merged over its base channels.
func subCells(d *data, m *itemRef) []subCell {
	var info *wiring.ItemInfo
	for i := range d.wiring.Items {
		if d.wiring.Items[i].PlanID == m.planID && d.wiring.Items[i].ItemID == m.itemID {
			info = &d.wiring.Items[i]
		}
	}
	w := math.Max(m.widthTE, 1)
	if info == nil {
		return []subCell{{from: m.offsetTE, to: m.offsetTE + w}}
	}
	type native struct {
		key string
		no  int
		ch  wiring.ChannelInfo
	}
	var natives []native
	for _, ch := range info.Channels {
		if !ch.Alternative {
			natives = append(natives, native{ch.OutputKindKey, ch.ChannelNo, ch})
		}
	}
	if len(natives) == 0 {
		return []subCell{{from: m.offsetTE, to: m.offsetTE + w}}
	}
	step := w / float64(len(natives))
	// Used alternatives cover their base channels.
	covered := map[int]*wiring.ChannelInfo{}
	for i := range info.Channels {
		ch := &info.Channels[i]
		if !ch.Alternative || len(ch.ConnectionIDs) == 0 {
			continue
		}
		for j, n := range natives {
			if n.key == ch.BaseKindKey && n.no >= ch.BaseFrom && n.no <= ch.BaseTo {
				covered[j] = ch
			}
		}
	}
	var out []subCell
	for j := 0; j < len(natives); {
		start := j
		ch := &natives[j].ch
		var nos []string
		if alt := covered[j]; alt != nil {
			for j < len(natives) && covered[j] == alt {
				nos = append(nos, strconv.Itoa(natives[j].no))
				j++
			}
			ch = alt
		} else {
			nos = []string{strconv.Itoa(natives[j].no)}
			j++
		}
		c := subCell{from: m.offsetTE + float64(start)*step, to: m.offsetTE + float64(j)*step, no: strings.Join(nos, "+")}
		zones, needs := channelTexts(d, ch.ConnectionIDs)
		switch {
		case len(needs) > 0:
			c.lines = []string{zones, needs}
		default:
			c.free = true
			c.lines = []string{"–"}
		}
		out = append(out, c)
	}
	return out
}

// channelTexts: the zone short names and the needs of a channel's
// connections ("Liv", "Ceiling spots, Wall").
func channelTexts(d *data, ids []uuid.UUID) (string, string) {
	var zones, needs []string
	for _, id := range ids {
		c := connectionByID(d, id)
		if c == nil {
			continue
		}
		n := d.needByKey[[2]uuid.UUID{c.NeedPlanID, c.NeedID}]
		if n == nil {
			continue
		}
		if z := d.zoneShort(n); z != "" && !slices.Contains(zones, z) {
			zones = append(zones, z)
		}
		if s := d.needName(n); !slices.Contains(needs, s) {
			needs = append(needs, s)
		}
	}
	return strings.Join(zones, "/"), strings.Join(needs, ", ")
}

// stripTable: a TE ruler, then the
// label: a top band per module and a bottom band per channel, free TE as
// empty cells; dashed cut lines around modules and free TE, thin lines
// inside a module. The grid has a column for every boundary.
func stripTable(d *data, s strip) document.Table {
	type cellAt struct {
		from, to float64
		cell     document.Cell
	}
	var ruler, top, bottom []cellAt
	bounds := []float64{s.from, s.to}
	addBound := func(x ...float64) { bounds = append(bounds, x...) }
	for x := math.Floor(s.from); x < s.to-1e-6; x++ {
		from, to := math.Max(x, s.from), math.Min(x+1, s.to)
		addBound(from, to)
		ruler = append(ruler, cellAt{from, to, document.Cell{Runs: []document.Run{{Text: strconv.Itoa(teNo(x)), SizePt: labelRulerPt}},
			Borders: &document.Borders{Top: document.LineNone, Bottom: document.LineNone, Left: document.LineThin, Right: document.LineThin}}})
	}
	cut, thin, none := document.LineCut, document.LineThin, document.LineNone
	pos := s.from
	freeTE := func(from, to float64) {
		for x := from; x < to-1e-6; {
			next := math.Min(math.Floor(x+1e-6)+1, to)
			addBound(x, next)
			top = append(top, cellAt{x, next, document.Cell{Borders: &document.Borders{Top: cut, Left: cut, Right: cut, Bottom: none}}})
			bottom = append(bottom, cellAt{x, next, document.Cell{Borders: &document.Borders{Top: none, Left: cut, Right: cut, Bottom: cut}}})
			x = next
		}
	}
	for _, m := range s.mods {
		if m.offsetTE > pos+1e-6 {
			freeTE(pos, m.offsetTE)
		}
		end := modEnd(m)
		addBound(m.offsetTE, end)
		widthMM := (end - m.offsetTE) * labelMMPerTE
		label := m.label
		if label == "" {
			label = d.model(m.variantID)
		}
		titleText := strings.TrimSpace(m.position + " " + label)
		top = append(top, cellAt{m.offsetTE, end, document.Cell{
			Runs:    []document.Run{{Text: fit(titleText, widthMM-2*labelMarginMM, labelTitlePt, true), Bold: true, SizePt: labelTitlePt, ScalePct: labelScalePct}},
			Borders: &document.Borders{Top: cut, Left: cut, Right: cut, Bottom: thin}}})
		subs := subCells(d, m)
		for i, c := range subs {
			b := &document.Borders{Top: thin, Bottom: cut, Left: thin, Right: thin}
			if i == 0 {
				b.Left = cut
			}
			if i == len(subs)-1 {
				b.Right = cut
			}
			addBound(c.from, c.to)
			bottom = append(bottom, cellAt{c.from, c.to, subCellContent(c, (c.to-c.from)*labelMMPerTE, b)})
		}
		pos = math.Max(pos, end)
	}
	if s.to > pos+1e-6 {
		freeTE(pos, s.to)
	}
	slices.Sort(bounds)
	bounds = slices.CompactFunc(bounds, func(a, b float64) bool { return math.Abs(a-b) < 1e-6 })
	t := document.Table{Borderless: true, WidthMM: (s.to - s.from) * labelMMPerTE, CellMarginMM: labelMarginMM}
	for i := 1; i < len(bounds); i++ {
		t.Columns = append(t.Columns, document.Column{Weight: bounds[i] - bounds[i-1], Align: document.AlignCenter})
	}
	index := func(x float64) int {
		return slices.IndexFunc(bounds, func(b float64) bool { return math.Abs(b-x) < 1e-6 })
	}
	row := func(cells []cellAt, height float64) document.Row {
		r := document.Row{HeightMM: height}
		for _, c := range cells {
			c.cell.Span = index(c.to) - index(c.from)
			r.Cells = append(r.Cells, c.cell)
		}
		return r
	}
	t.Rows = []document.Row{
		row(ruler, labelRulerMM),
		row(top, labelTopMM),
		row(bottom, labelBottomMM),
	}
	t.KeepTogether = true
	return t
}

// subCellContent: the channel number (bold) and its lines, cut to the
// cell; narrow cells turn the text.
func subCellContent(c subCell, widthMM float64, b *document.Borders) document.Cell {
	cell := document.Cell{Borders: b}
	if c.no == "" {
		return cell
	}
	vertical := widthMM < labelVerticalMM
	avail := widthMM - 2*labelMarginMM
	if vertical {
		avail = labelBottomMM - 1
		cell.Vertical = true
	}
	no := c.no
	if c.free {
		no += " –"
	}
	cell.Runs = []document.Run{{Text: no, Bold: true, SizePt: labelNoPt, ScalePct: labelScalePct}}
	if c.free {
		return cell
	}
	lines := c.lines
	if vertical {
		// A turned cell holds about one line per 2.8 mm of width after the
		// number.
		room := max(int((widthMM-2*labelMarginMM)/2.8)-1, 0)
		if room == 0 {
			// Only the number and the zone in one line.
			cell.Runs[0].Text = fit(no+" "+lines[0], avail, labelNoPt, true)
			return cell
		}
		lines = lines[:min(room, len(lines))]
	}
	for _, s := range lines {
		if s == "" {
			continue
		}
		cell.Runs = append(cell.Runs, document.Run{Text: "\n" + fit(s, avail, labelTextPt, false), SizePt: labelTextPt, ScalePct: labelScalePct})
	}
	return cell
}

// fit cuts s with "…" to about widthMM at a font size (Arial, condensed
// to labelScalePct): the document model cannot ellipsize.
func fit(s string, widthMM, pt float64, bold bool) string {
	if textMM(s, pt, bold) <= widthMM {
		return s
	}
	r := []rune(s)
	for len(r) > 0 {
		r = r[:len(r)-1]
		t := strings.TrimRightFunc(string(r), unicode.IsSpace) + "…"
		if textMM(t, pt, bold) <= widthMM {
			return t
		}
	}
	return ""
}

// textMM estimates a text's width in mm (Arial character widths in em).
func textMM(s string, pt float64, bold bool) float64 {
	em := 0.0
	for _, r := range s {
		switch {
		case strings.ContainsRune("iIjl.,:;'|!", r):
			em += 0.28
		case strings.ContainsRune("ftr()[]- ", r):
			em += 0.34
		case strings.ContainsRune("mwMW", r):
			em += 0.86
		case r == '…':
			em += 1
		case unicode.IsUpper(r):
			em += 0.68
		case unicode.IsDigit(r):
			em += 0.56
		default:
			em += 0.54
		}
	}
	if bold {
		em *= 1.07
	}
	return em * pt * 25.4 / 72 * labelScalePct / 100
}
