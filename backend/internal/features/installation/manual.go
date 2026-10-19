package installation

// The installation manual (3e, D421): cover with the letterhead, overview
// (systems, bus lines, gateways, open findings), per board a drawing,
// module list, channel table and free channels, per floorplan the plan
// image with devices and numbered need symbols and per zone the devices
// and needs. Existing devices are marked; prices never appear.

import (
	"context"
	"fmt"
	"image/color"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/planimage"
)

// header is what every document of a run prints on its cover and pages.
type header struct {
	number      string
	date        time.Time
	project     projects.Project
	versionName string
	letterhead  document.Letterhead
}

func (h header) document(l tr, title string) document.Document {
	return document.Document{
		Title: title + " " + h.number, Language: string(l.norm()), Author: h.letterhead.Company,
		Header:        h.letterhead.Header(),
		Footer:        &document.Footer{Text: h.letterhead.Company + " · " + h.number, PageLabel: l.t("page")},
		CompactHeader: h.letterhead.Compact(),
	}
}

// facts is the cover's customer and document facts.
func (h header) facts(l tr) document.Table {
	cu := h.project.Customer
	var customer []document.Run
	add := func(s string, bold bool) {
		if s == "" {
			return
		}
		if len(customer) > 0 {
			s = "\n" + s
		}
		customer = append(customer, document.Run{Text: s, Bold: bold})
	}
	add(cu.Company, true)
	add(cu.Name, cu.Company == "")
	add(cu.Address, false)
	add(cu.Phone, false)
	facts := []document.Run{
		{Text: l.t("number") + ": ", Bold: true}, {Text: h.number},
		{Text: "\n" + l.t("date") + ": ", Bold: true}, {Text: l.date(h.date)},
		{Text: "\n" + l.t("project") + ": ", Bold: true}, {Text: h.project.Number + " " + h.project.Name},
		{Text: "\n" + l.t("version") + ": ", Bold: true}, {Text: h.versionName},
	}
	return document.Table{Borderless: true, Columns: []document.Column{{Weight: 1}, {Weight: 1}},
		Rows: []document.Row{{Cells: []document.Cell{{Runs: customer}, {Runs: facts}}}}}
}

// planPage is a rendered floorplan with its symbol numbers.
type planPage struct {
	plan  plans.DocumentPlan
	image pngImage
	// symbol numbers of the needs ("1", "2", …) in plan order.
	numbers map[uuid.UUID]string
	// marks are the devices' letters ("A", "B", …, "AA") in plan order:
	// the plan shows them, the zone tables explain them.
	marks map[uuid.UUID]string
}

// mark is the n-th device letter (0: "A", 25: "Z", 26: "AA").
func mark(n int) string {
	s := ""
	for n++; n > 0; n = (n - 1) / 26 {
		s = string(rune('A'+(n-1)%26)) + s
	}
	return s
}

// floorplans renders the floorplans with devices and need symbols; every
// need of the plan gets a number in zone and need order, shown on its
// symbol (when it has a position) and in the zone tables.
func (s *Service) floorplans(ctx context.Context, d *data) ([]planPage, error) {
	docPlans, err := s.plans.DocumentPlans(ctx, d.ref.ID)
	if err != nil {
		return nil, err
	}
	var ids []uuid.UUID
	for _, p := range docPlans {
		for _, pl := range p.Placements {
			if pl.VariantID != nil {
				ids = append(ids, *pl.VariantID)
			}
		}
	}
	if err := s.addVariants(ctx, d, ids); err != nil {
		return nil, err
	}
	var out []planPage
	for _, p := range docPlans {
		page := planPage{plan: p, numbers: map[uuid.UUID]string{}, marks: map[uuid.UUID]string{}}
		for i, n := range orderedNeeds(d, p.ID) {
			page.numbers[n.NeedID] = strconv.Itoa(i + 1)
		}
		for i, pl := range p.Placements {
			page.marks[pl.ID] = mark(i)
		}
		bg, err := s.files.DecodeImage(ctx, p.Image, maxPlanPixels)
		page.plan.Image = nil
		if err != nil {
			return nil, err
		}
		if bg != nil {
			in := planimage.Plan{Background: bg, TextScale: 1.5}
			if p.Width > 0 && p.Height > 0 {
				in.Size.X, in.Size.Y = int(p.Width), int(p.Height)
			}
			for _, z := range p.Zones {
				in.Zones = append(in.Zones, planimage.Zone{Name: z.Name, Color: hexColor(z.Color), Opacity: z.Opacity, Points: z.Points})
			}
			for _, pl := range p.Placements {
				it := planimage.Placement{X: pl.X, Y: pl.Y, Width: pl.Width, Height: pl.Height, Rotation: pl.Rotation, Existing: pl.Existing}
				// The device's letter; label and address are in the zone
				// tables (long labels collided on dense plans).
				it.Label = page.marks[pl.ID]
				if pl.VariantID != nil {
					if v, ok := d.variants[*pl.VariantID]; ok {
						it.Color = hexColor(v.ProductType.Color)
					}
				}
				in.Placements = append(in.Placements, it)
			}
			for _, n := range p.Needs {
				if n.X == nil || n.Y == nil {
					continue
				}
				in.Symbols = append(in.Symbols, planimage.Symbol{X: *n.X, Y: *n.Y, Text: page.numbers[n.ID], Color: color.RGBA{0x1d, 0x4e, 0xd8, 0xff}})
			}
			img, err := encodePNG(planimage.RenderMax(in, maxPlanPixels))
			if err != nil {
				return nil, err
			}
			page.image = img
		}
		out = append(out, page)
	}
	return out, nil
}

// orderedNeeds are a plan's needs in zone and need order (the wiring view's
// order).
func orderedNeeds(d *data, planID uuid.UUID) []wiring.NeedInfo {
	var out []wiring.NeedInfo
	for _, n := range d.wiring.Needs {
		if n.PlanID == planID {
			out = append(out, n)
		}
	}
	return out
}

// manual builds the installation manual.
func manual(d *data, h header, pages []planPage) document.Document {
	l := d.lang
	doc := h.document(l, l.t("manualTitle"))
	main := document.Section{Orientation: document.Portrait}
	add := func(b ...document.Block) { main.Blocks = append(main.Blocks, b...) }
	add(document.Heading{Level: 1, Text: l.t("manualTitle")}, h.facts(l), document.Spacer{})
	add(document.Paragraph{Runs: []document.Run{{Text: l.t("manualIntro")}}, Style: document.Muted})

	// 1. Overview.
	add(document.Heading{Level: 2, Text: l.t("overview")})
	add(overview(d)...)

	// 2. Boards.
	for _, p := range d.plans {
		if p.Kind == plans.KindBoard {
			add(document.PageBreak{})
			add(boardBlocks(d, p)...)
		}
	}
	doc.Sections = append(doc.Sections, main)

	// 3. Floorplans: the plan (landscape), then its zones (portrait).
	for _, pg := range pages {
		if pg.image.data != nil {
			w, hh := 257.0, 257.0*float64(pg.image.height)/float64(max(pg.image.width, 1))
			if hh > 150 {
				w, hh = w*150/hh, 150
			}
			doc.Sections = append(doc.Sections, document.Section{Orientation: document.Landscape, Blocks: []document.Block{
				document.Heading{Level: 2, Text: pg.plan.Name},
				document.Image{PNG: pg.image.data, WidthMM: w, HeightMM: hh, Align: document.AlignCenter},
				document.Paragraph{Runs: []document.Run{{Text: l.t("planLegend")}}, Style: document.Small},
			}})
		}
		doc.Sections = append(doc.Sections, document.Section{Orientation: document.Portrait, Blocks: zoneBlocks(d, pg)})
	}
	return doc
}

func headerRow(cells ...string) document.Row {
	r := document.Row{Kind: document.HeaderRow}
	for _, c := range cells {
		r.Cells = append(r.Cells, document.TextCell(c))
	}
	return r
}

func bodyRow(cells ...string) document.Row {
	r := document.Row{}
	for _, c := range cells {
		r.Cells = append(r.Cells, document.TextCell(c))
	}
	return r
}

func cols(weights ...float64) []document.Column {
	out := make([]document.Column, len(weights))
	for i, w := range weights {
		out[i] = document.Column{Weight: w}
	}
	return out
}

// overview: systems with their lines and gateways, and open findings.
func overview(d *data) []document.Block {
	l := d.lang
	var out []document.Block
	status := map[uuid.UUID]wiring.BusLineStatus{}
	for _, s := range d.checks.BusLines {
		status[s.BusLineID] = s
	}
	if len(d.networks.BusSystems) > 0 {
		t := document.Table{Columns: cols(1.4, 1, 1, 2, 1.4, 1), Rows: []document.Row{headerRow(l.t("colLine"), l.t("colSystem"),
			l.t("colPrefix"), l.t("colSupplies"), l.t("colCurrent"), l.t("colDevices"))}}
		for _, sys := range d.networks.BusSystems {
			for _, line := range sys.Lines {
				var supplies []string
				for _, m := range line.Members {
					if m.PowerSupply {
						supplies = append(supplies, d.itemName(d.item(m.PlanID, m.ItemID)))
					}
				}
				st := status[line.ID]
				devices := strconv.Itoa(st.Devices)
				if st.DevicesMax != nil {
					devices += " / " + strconv.Itoa(int(*st.DevicesMax))
				}
				prefix := d.prefixByID[line.ID]
				prefixText := prefix.Prefix
				if prefix.Default && prefixText != "" {
					prefixText += " (" + l.t("defaultMark") + ")"
				}
				t.Rows = append(t.Rows, bodyRow(line.Name, text(sys.ProductType.Name, l), prefixText, strings.Join(supplies, ", "),
					l.num(st.CurrentUsedMa)+" / "+l.num(st.CurrentSuppliedMa)+" mA", devices))
			}
		}
		out = append(out, document.Heading{Level: 3, Text: l.t("busLines")}, t)
	}
	if len(d.checks.Gateways) > 0 {
		t := document.Table{Columns: cols(2, 1.4, 1.2, 1), Rows: []document.Row{headerRow(l.t("colGateway"), l.t("colLocation"), l.t("colPlaces"),
			l.t("colDevices"))}}
		for _, g := range d.checks.Gateways {
			it := d.item(g.PlanID, g.ItemID)
			t.Rows = append(t.Rows, bodyRow(d.itemName(it), d.location(it), l.num(g.PlacesUsed)+" / "+l.num(g.PlacesSupplied), strconv.Itoa(g.Devices)))
		}
		out = append(out, document.Heading{Level: 3, Text: l.t("gateways")}, t)
	}
	out = append(out, document.Heading{Level: 3, Text: l.t("openFindings")})
	var open []wiring.Finding
	for _, f := range d.checks.Findings {
		if f.Severity != wiring.SeverityInfo {
			open = append(open, f)
		}
	}
	if len(open) == 0 {
		out = append(out, document.Text(l.t("noFindings")))
	} else {
		t := document.Table{Columns: cols(0.8, 4), Rows: []document.Row{headerRow(l.t("colSeverity"), l.t("colFinding"))}}
		for _, f := range open {
			t.Rows = append(t.Rows, bodyRow(l.t("severity-"+string(f.Severity)), findingText(d, f)))
		}
		out = append(out, t)
	}
	out = append(out, document.Paragraph{Runs: []document.Run{{Text: l.t("noCables")}}, Style: document.Muted})
	return out
}

// findingText is a short readable text of a finding: the subject (item,
// need, zone or line) and the rule.
func findingText(d *data, f wiring.Finding) string {
	l := d.lang
	var subject []string
	if f.Refs.ItemID != nil && f.Refs.TargetPlanID != nil {
		it := d.item(*f.Refs.TargetPlanID, *f.Refs.ItemID)
		s := d.itemName(it)
		if f.Refs.OutputKindID != nil && f.Refs.ChannelNo != nil {
			s += " · " + d.channelText(*f.Refs.OutputKindID, int32(*f.Refs.ChannelNo))
		}
		subject = append(subject, s)
	}
	if f.Refs.NeedID != nil && f.Refs.PlanID != nil {
		if n := d.needByKey[[2]uuid.UUID{*f.Refs.PlanID, *f.Refs.NeedID}]; n != nil {
			subject = append(subject, strings.TrimSpace(n.ZoneName+" "+d.needName(n)))
		}
	}
	if f.Refs.BusLineID != nil {
		if line, ok := d.lineByID[*f.Refs.BusLineID]; ok {
			subject = append(subject, line.Name)
		}
	}
	if len(subject) == 0 {
		if name, ok := f.Params["name"].(string); ok && name != "" {
			subject = append(subject, name)
		}
	}
	rule := l.finding(f.Code, f.Params)
	if len(subject) == 0 {
		return rule
	}
	return strings.Join(subject, " / ") + ": " + rule
}

// boardBlocks: drawing, module list, channel table, free channels.
func boardBlocks(d *data, p plans.Plan) []document.Block {
	l := d.lang
	b := d.boards[p.ID]
	out := []document.Block{document.Heading{Level: 2, Text: p.Name}}
	if b.EnclosureVariantID != nil {
		out = append(out, document.Paragraph{Runs: []document.Run{{Text: l.t("enclosure") + ": ", Bold: true},
			{Text: d.productName(b.EnclosureVariantID) + " " + d.model(b.EnclosureVariantID)}}})
	}
	var mods []*itemRef
	for _, it := range d.itemByKey {
		if it.planID == p.ID && it.board {
			mods = append(mods, it)
		}
	}
	slices.SortFunc(mods, func(a, c *itemRef) int { return posNo(a.position) - posNo(c.position) })
	// The drawing.
	draw := planimage.Board{}
	for i, r := range b.Rows {
		row := planimage.BoardRow{Name: l.t("row", i+1), CapacityTE: r.CapacityTE}
		for _, m := range mods {
			if m.rowIndex != i {
				continue
			}
			bm := planimage.BoardModule{OffsetTE: m.offsetTE, WidthTE: m.widthTE, Position: m.position, Label: m.label, Existing: m.existing}
			if bm.Label == "" {
				bm.Label = d.model(m.variantID)
			}
			if m.variantID != nil {
				if v, ok := d.variants[*m.variantID]; ok {
					bm.Color = hexColor(v.ProductType.Color)
				}
			}
			row.Modules = append(row.Modules, bm)
		}
		draw.Rows = append(draw.Rows, row)
	}
	if img, err := encodePNG(planimage.RenderBoard(draw)); err == nil {
		w, h := 170.0, 170.0*float64(img.height)/float64(max(img.width, 1))
		if h > 120 {
			w, h = w*120/h, 120
		}
		out = append(out, document.Image{PNG: img.data, WidthMM: w, HeightMM: h, Align: document.AlignCenter})
	}
	// Module list.
	if len(mods) == 0 {
		return append(out, document.Text(l.t("noModules")))
	}
	t := document.Table{Columns: cols(0.6, 0.6, 1.5, 2.3, 0.5, 1.0, 1.0), Rows: []document.Row{headerRow(l.t("colPos"), l.t("colRow"), l.t("colLabel"),
		l.t("colProduct"), l.t("colTE"), l.t("colAddress"), l.t("colLine"))}}
	for _, m := range mods {
		product := d.productName(m.variantID)
		if mn := d.model(m.variantID); mn != "" {
			product += " (" + mn + ")"
		}
		if m.existing {
			product += " – " + l.t("existingMark")
		}
		addr, line := "", ""
		if a, ok := d.addrByKey[[2]uuid.UUID{m.planID, m.itemID}]; ok {
			addr, line = addressText(a), d.networkText(a)
		}
		t.Rows = append(t.Rows, bodyRow(m.position, strconv.Itoa(m.rowIndex+1), m.label, product, l.num(m.widthTE), addr, line))
	}
	out = append(out, document.Heading{Level: 3, Text: l.t("modules")}, t)

	// Channel table and free channels.
	ct := document.Table{Columns: cols(0.6, 1.4, 1.1, 2.3, 1.4, 1.0), Rows: []document.Row{headerRow(l.t("colPos"), l.t("colChannel"),
		l.t("colZone"), l.t("colNeed"), l.t("colLoad"), l.t("colCircuit"))}}
	var free []string
	var items []wiring.ItemInfo
	for _, info := range d.wiring.Items {
		if info.PlanID == p.ID {
			items = append(items, info)
		}
	}
	// By module position (D1, D2, …), then channel number (native kinds
	// before alternatives at the same number).
	slices.SortStableFunc(items, func(a, c wiring.ItemInfo) int {
		return posNo(d.item(a.PlanID, a.ItemID).position) - posNo(d.item(c.PlanID, c.ItemID).position)
	})
	for _, info := range items {
		it := d.item(info.PlanID, info.ItemID)
		var freeNos []string
		channels := slices.Clone(info.Channels)
		// An alternative channel sorts at its first base channel.
		at := func(c wiring.ChannelInfo) int {
			if c.Alternative {
				return c.BaseFrom
			}
			return c.ChannelNo
		}
		slices.SortStableFunc(channels, func(a, c wiring.ChannelInfo) int { return at(a) - at(c) })
		for _, ch := range channels {
			chText := d.channelText(ch.OutputKindID, int32(ch.ChannelNo))
			if ch.Alternative {
				chText += " (" + d.kindNameByKey(ch.BaseKindKey) + " " + strconv.Itoa(ch.BaseFrom) + "+" + strconv.Itoa(ch.BaseTo) + ")"
			}
			if len(ch.ConnectionIDs) == 0 {
				if !ch.Blocked && !ch.Alternative {
					freeNos = append(freeNos, chText)
				}
				continue
			}
			circuit := ""
			if len(ch.ConnectionIDs) > 1 {
				circuit = l.t("circuitMark")
			}
			for _, id := range ch.ConnectionIDs {
				c := connectionByID(d, id)
				if c == nil {
					continue
				}
				n := d.needByKey[[2]uuid.UUID{c.NeedPlanID, c.NeedID}]
				if n == nil {
					continue
				}
				ct.Rows = append(ct.Rows, bodyRow(it.position, chText, n.ZoneName, d.needWithFunction(n),
					d.loadText(n, c.Units), circuit))
			}
		}
		if len(freeNos) > 0 {
			free = append(free, it.position+": "+strings.Join(freeNos, ", "))
		}
	}
	if len(ct.Rows) > 1 {
		out = append(out, document.Heading{Level: 3, Text: l.t("channels")}, ct)
	}
	out = append(out, document.Heading{Level: 3, Text: l.t("freeChannels")})
	if len(free) == 0 {
		out = append(out, document.Text(l.t("noFreeChannels")))
	} else {
		out = append(out, document.Text(strings.Join(free, "\n")))
	}
	return out
}

func posNo(p string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(p, "D"))
	return n
}

func connectionByID(d *data, id uuid.UUID) *wiring.Connection {
	for i := range d.wiring.Connections {
		if d.wiring.Connections[i].ID == id {
			return &d.wiring.Connections[i]
		}
	}
	return nil
}

// zoneBlocks: per zone of a floorplan its devices and needs.
func zoneBlocks(d *data, pg planPage) []document.Block {
	l := d.lang
	p := pg.plan
	out := []document.Block{document.Heading{Level: 2, Text: l.t("zonesOf", p.Name)}}
	type zone struct {
		id   *uuid.UUID
		name string
	}
	var zones []zone
	for _, z := range p.Zones {
		id := z.ID
		zones = append(zones, zone{&id, z.Name})
	}
	zones = append(zones, zone{nil, l.t("noZone")})
	needs := orderedNeeds(d, p.ID)
	for _, z := range zones {
		var devs []plans.PlanPlacement
		for _, pl := range p.Placements {
			if sameZone(pl.ZoneID, z.id) {
				devs = append(devs, pl)
			}
		}
		var zn []wiring.NeedInfo
		for _, n := range needs {
			if sameZone(n.ZoneID, z.id) {
				zn = append(zn, n)
			}
		}
		if len(devs) == 0 && len(zn) == 0 {
			continue
		}
		out = append(out, document.Heading{Level: 3, Text: z.name})
		if len(devs) > 0 {
			t := document.Table{Columns: cols(0.6, 1.2, 2.3, 1.8, 1.2), Rows: []document.Row{headerRow(l.t("colMark"), l.t("colDevice"), l.t("colProduct"),
				l.t("colAddress"), l.t("colNetwork"))}}
			for _, pl := range devs {
				product := d.productName(pl.VariantID)
				if mn := d.model(pl.VariantID); mn != "" {
					product += " (" + mn + ")"
				}
				if pl.Existing {
					product += " – " + l.t("existingMark")
				}
				addr, network := "", ""
				if a, ok := d.addrByKey[[2]uuid.UUID{p.ID, pl.ID}]; ok {
					addr, network = addressText(a), d.networkText(a)
				}
				label := pl.Label
				if label == "" {
					label = "–"
				}
				t.Rows = append(t.Rows, bodyRow(pg.marks[pl.ID], label, product, addr, network))
			}
			out = append(out, t)
		}
		if len(zn) > 0 {
			t := document.Table{Columns: cols(0.4, 2, 1.4, 2.8), Rows: []document.Row{headerRow(l.t("colNo"), l.t("colNeed"), l.t("colLoad"),
				l.t("colConnected"))}}
			for _, n := range zn {
				conns := d.connectionsOf(n.PlanID, n.NeedID)
				connected := strings.Join(conns, "\n")
				if n.ConnectedUnits < n.Quantity {
					missing := l.t("notConnected", n.Quantity-n.ConnectedUnits)
					if connected != "" {
						connected += "\n"
					}
					connected += missing
				}
				t.Rows = append(t.Rows, bodyRow(pg.numbers[n.NeedID], d.needWithFunction(&n),
					d.loadText(&n, n.Quantity), connected))
			}
			out = append(out, t)
		}
	}
	return out
}

func hexColor(s string) color.RGBA {
	var c color.RGBA
	if len(s) == 7 && s[0] == '#' {
		if _, err := fmt.Sscanf(s[1:], "%02x%02x%02x", &c.R, &c.G, &c.B); err == nil {
			c.A = 0xff
			return c
		}
	}
	return color.RGBA{0x64, 0x74, 0x8b, 0xff}
}
