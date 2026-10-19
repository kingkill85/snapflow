package proposals

import (
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Per-plan quantity columns are shown for 2 to 5 plans (spec 2d).
const (
	minPlanColumns = 2
	maxPlanColumns = 5
)

// image is a PNG with its pixel size.
type pngImage struct {
	data          []byte
	width, height int
}

// planPage is a rendered plan of a document.
type planPage struct {
	name   string
	image  pngImage
	legend []legendEntry
	// existing: the page shows existing devices (hatched).
	existing bool
}

// legendEntry counts a product type's devices on a plan: count new ones
// (in the BOM), existing ones apart.
type legendEntry struct {
	name     string
	count    int
	existing int
}

// content is everything one proposal document is built from.
type content struct {
	lang        tr
	number      string
	date        time.Time
	project     projects.Project
	versionName string
	tenantName  string
	letterhead  tenants.Letterhead
	logo        *pngImage
	bom         bom.BOM
	// productType is the type of a split document, nil for the combined one.
	productType *bom.SnapshotProductType
	plans       []planPage
}

func text(t i18n.Text, lang tr) string {
	if s := strings.TrimSpace(t[string(lang)]); s != "" {
		return s
	}
	return t[i18n.DefaultLocale]
}

// build turns the content into the format-neutral document.
func (c content) build() document.Document {
	l := c.lang
	title := l.t("title")
	if c.productType != nil {
		title += " – " + text(c.productType.Name, l)
	}
	company := c.letterhead.CompanyName
	if company == "" {
		company = c.tenantName
	}
	doc := document.Document{
		Title: title + " " + c.number, Language: string(l), Author: company,
		Header: c.header(company),
		Footer: &document.Footer{Text: company + " · " + l.t("number") + " " + c.number, PageLabel: l.t("page")},
		// Only the company name: no 4 cm letterhead space needed.
		CompactHeader: c.logo == nil && c.letterhead.Address == "" && c.letterhead.Phone == "" && c.letterhead.Email == "" && c.letterhead.Website == "",
	}
	main := document.Section{Orientation: document.Portrait}
	add := func(b ...document.Block) { main.Blocks = append(main.Blocks, b...) }
	add(document.Heading{Level: 1, Text: title})
	add(c.titleBlock())
	if t := text(c.bom.Pricing.IntroText, l); t != "" {
		add(document.Spacer{}, document.Text(t))
	}
	add(document.Heading{Level: 2, Text: l.t("bom")}, c.bomTable())
	if c.planColumns() {
		var keys []string
		for i, p := range c.bom.Plans {
			keys = append(keys, l.t("planColumn", i+1)+": "+p.Name)
		}
		add(document.Paragraph{Runs: []document.Run{{Text: l.t("planColumns") + ": ", Bold: true}, {Text: strings.Join(keys, " · ")}}, Style: document.Small})
	}
	add(c.totalsTable())
	notes := []string{l.t("net")}
	if c.converted() {
		notes = append(notes, l.t("converted", l.number(c.bom.Totals.Rate), c.bom.Totals.Currency))
	}
	add(document.Paragraph{Runs: []document.Run{{Text: strings.Join(notes, " ")}}, Style: document.Muted})
	if t := text(c.bom.Pricing.ClosingText, l); t != "" {
		add(document.Spacer{}, document.Text(t))
	}
	if zones := c.zoneTables(); len(zones) > 0 {
		add(document.Heading{Level: 2, Text: l.t("zones")})
		add(zones...)
	}
	doc.Sections = append(doc.Sections, main)
	for _, p := range c.plans {
		doc.Sections = append(doc.Sections, c.planSection(p))
	}
	return doc
}

func (c content) header(company string) *document.Block {
	lines := []document.Run{{Text: company, Bold: true}}
	lh := c.letterhead
	if lh.Address != "" {
		lines = append(lines, document.Run{Text: "\n" + lh.Address})
	}
	var contact []string
	for _, s := range []string{lh.Phone, lh.Email, lh.Website} {
		if s != "" {
			contact = append(contact, s)
		}
	}
	// One line when it fits the column, else a line each (a wrapped
	// website or email breaks at its hyphens, D271).
	if joined := strings.Join(contact, " · "); len([]rune(joined)) <= maxContactLine {
		lines = append(lines, document.Run{Text: "\n" + joined})
	} else {
		for _, s := range contact {
			lines = append(lines, document.Run{Text: "\n" + s})
		}
	}
	right := document.Cell{Runs: lines}
	left := document.Cell{}
	if c.logo != nil {
		// At most 45 × 18 mm, aspect kept.
		w, h := 45.0, 45.0*float64(c.logo.height)/float64(max(c.logo.width, 1))
		if h > 18 {
			w, h = w*18/h, 18
		}
		left.Image = &document.Image{PNG: c.logo.data, WidthMM: w, HeightMM: h}
	}
	var b document.Block = document.Table{Borderless: true, Columns: []document.Column{{Weight: 1}, {Weight: 2.4, Align: document.AlignRight}},
		Rows: []document.Row{{Cells: []document.Cell{left, right}}}}
	return &b
}

// maxContactLine: characters of "phone · email · website" that fit the
// letterhead's text column (about 120 mm at 9.5 pt) on one line.
const maxContactLine = 75

func (c content) titleBlock() document.Table {
	l := c.lang
	cu := c.project.Customer
	var customer []document.Run
	addLine := func(s string, bold bool) {
		if s == "" {
			return
		}
		if len(customer) > 0 {
			s = "\n" + s
		}
		customer = append(customer, document.Run{Text: s, Bold: bold})
	}
	addLine(cu.Company, true)
	addLine(cu.Name, cu.Company == "")
	addLine(cu.Address, false)
	addLine(cu.Email, false)
	addLine(cu.Phone, false)
	facts := []document.Run{
		{Text: l.t("number") + ": ", Bold: true}, {Text: c.number},
		{Text: "\n" + l.t("date") + ": ", Bold: true}, {Text: l.date(c.date)},
		{Text: "\n" + l.t("project") + ": ", Bold: true}, {Text: c.project.Number + " " + c.project.Name},
		{Text: "\n" + l.t("version") + ": ", Bold: true}, {Text: c.versionName},
	}
	return document.Table{Borderless: true, Columns: []document.Column{{Weight: 1}, {Weight: 1}},
		Rows: []document.Row{{Cells: []document.Cell{{Runs: customer}, {Runs: facts}}}}}
}

func (c content) converted() bool { return c.bom.Totals.Converted != nil }

// amounts of a line in the document currency.
func (c content) lineAmounts(line bom.BOMLine) (unit, total string) {
	if c.converted() && line.Converted != nil {
		return line.Converted.UnitPrice, line.Converted.Total
	}
	return line.UnitPrice, line.Total
}

func (c content) groupAmount(usd string, converted *string) string {
	if c.converted() && converted != nil {
		return *converted
	}
	return usd
}

// quantityPlans are the plans with a quantity on some line (a split
// document leaves out the plans without its product type, D271).
func (c content) quantityPlans() []bom.BOMPlanRef {
	var out []bom.BOMPlanRef
	for _, p := range c.bom.Plans {
		for _, ln := range c.bom.Lines {
			if ln.Quantities.Plans[p.ID.String()] != 0 {
				out = append(out, p)
				break
			}
		}
	}
	return out
}

func (c content) planColumns() bool {
	n := len(c.quantityPlans())
	return n >= minPlanColumns && n <= maxPlanColumns
}

func (c content) bomTable() document.Table {
	l := c.lang
	cur := c.bom.Totals.Currency
	right := document.AlignRight
	// Position and quantity wide enough for "Pos." and "Menge" without a
	// break inside the word; plan columns get a short header ("P1") that
	// the legend under the table maps to the plan's name.
	cols := []document.Column{{Weight: 1}, {Weight: 5}}
	head := []document.Cell{document.TextCell(l.t("pos")), document.TextCell(l.t("description"))}
	if c.planColumns() {
		for i := range c.quantityPlans() {
			cols = append(cols, document.Column{Weight: 0.8, Align: document.AlignRight})
			head = append(head, document.TextCell(l.t("planColumn", i+1)))
		}
	}
	cols = append(cols, document.Column{Weight: 1.3, Align: document.AlignRight}, document.Column{Weight: 1.7, Align: document.AlignRight}, document.Column{Weight: 1.9, Align: document.AlignRight})
	head = append(head, document.TextCell(l.t("quantity")), document.TextCell(l.t("amountCurrency", l.t("unitPrice"), cur)), document.TextCell(l.t("amountCurrency", l.t("total"), cur)))
	for i := 2; i < len(head); i++ {
		head[i].Align = &right
	}
	t := document.Table{Columns: cols, Rows: []document.Row{{Kind: document.HeaderRow, Cells: head}}}
	span := len(cols) - 1
	lines := map[string]bom.BOMLine{}
	for _, ln := range c.bom.Lines {
		lines[ln.Key] = ln
	}
	names := map[uuid.UUID]string{}
	for _, ln := range c.bom.Lines {
		if ln.VariantID != nil && ln.Snapshot != nil {
			names[*ln.VariantID] = text(ln.Snapshot.ProductName, l)
		}
	}
	pos := 0
	row := func(ln bom.BOMLine) document.Row {
		pos++
		desc := []document.Run{}
		indent := 0
		if ln.Snapshot != nil {
			name := text(ln.Snapshot.ProductName, l)
			if v := text(ln.Snapshot.VariantName, l); v != "" && v != name {
				name += " – " + v
			}
			desc = append(desc, document.Run{Text: name})
			detail := l.t("model", ln.Snapshot.ModelNumber)
			if ln.Snapshot.SKU != "" {
				detail += " · " + l.t("sku", ln.Snapshot.SKU)
			}
			desc = append(desc, document.Run{Text: "\n" + detail, Italic: true})
			if ln.Kind == bom.KindAddOn && len(ln.AddOnOf) > 0 {
				var of []string
				for _, id := range ln.AddOnOf {
					if n, ok := names[id]; ok && !slices.Contains(of, n) {
						of = append(of, n)
					}
				}
				desc = append(desc, document.Run{Text: "\n" + l.t("for", strings.Join(of, ", "))})
				indent = 1
			}
		} else {
			desc = append(desc, document.Run{Text: ln.Name})
		}
		cells := []document.Cell{document.TextCell(itoa(pos)), {Runs: desc, Indent: indent}}
		if c.planColumns() {
			for _, p := range c.quantityPlans() {
				q := ln.Quantities.Plans[p.ID.String()]
				s := ""
				if q != 0 {
					s = itoa64(q)
				}
				cells = append(cells, document.TextCell(s))
			}
		}
		unit, total := c.lineAmounts(ln)
		cells = append(cells, document.TextCell(itoa64(ln.Quantity)), document.TextCell(l.number(unit)), document.TextCell(l.number(total)))
		return document.Row{Cells: cells}
	}
	for _, g := range c.bom.Groups {
		name := l.t("otherItems")
		if g.ProductType != nil {
			name = text(g.ProductType.Name, l)
		}
		t.Rows = append(t.Rows, document.Row{Kind: document.GroupRow, Cells: []document.Cell{
			{Runs: []document.Run{{Text: name}}, Span: span}, {Runs: []document.Run{{Text: l.number(c.groupAmount(g.Subtotal, g.Converted))}}, Align: &right},
		}})
		for _, cat := range g.Categories {
			t.Rows = append(t.Rows, document.Row{Kind: document.SubgroupRow, Cells: []document.Cell{
				{Runs: []document.Run{{Text: text(cat.Category.Name, l), Italic: true}}, Span: span},
				{Runs: []document.Run{{Text: l.number(c.groupAmount(cat.Subtotal, cat.Converted)), Italic: true}}, Align: &right},
			}})
			for _, k := range cat.Lines {
				t.Rows = append(t.Rows, row(lines[k]))
			}
		}
		for _, k := range g.Lines {
			t.Rows = append(t.Rows, row(lines[k]))
		}
	}
	return t
}

func (c content) totalsTable() document.Table {
	l := c.lang
	tot := c.bom.Totals
	amounts := tot.BOMAmounts
	if tot.Converted != nil {
		amounts = tot.Converted.BOMAmounts
	}
	cur := tot.Currency
	p := c.bom.Pricing
	rows := []document.Row{{Cells: []document.Cell{document.TextCell(l.t("subtotal")), document.TextCell(l.money(amounts.Subtotal, cur))}}}
	if p.DiscountKind != "none" {
		label := l.t("discount")
		if p.DiscountKind == "percent" {
			label += " " + l.percent(p.DiscountValue)
		}
		rows = append(rows, document.Row{Cells: []document.Cell{document.TextCell(label), document.TextCell(l.money("-"+amounts.Discount, cur))}})
	}
	if p.ServicesKind != "none" {
		label := text(p.ServicesLabel, l)
		if p.ServicesKind == "percent" {
			label += " " + l.percent(p.ServicesValue)
		}
		rows = append(rows, document.Row{Cells: []document.Cell{document.TextCell(label), document.TextCell(l.money(amounts.Services, cur))}})
	}
	rows = append(rows, document.Row{Kind: document.TotalRow, Cells: []document.Cell{document.TextCell(l.t("grandTotal")), document.TextCell(l.money(amounts.GrandTotal, cur))}})
	return document.Table{Borderless: true, Columns: []document.Column{{Weight: 1.3}, {Weight: 2.1, Align: document.AlignRight}, {Weight: 1.1, Align: document.AlignRight}},
		Rows: shift(rows)}
}

// shift puts the totals in the right part of the width (the label column
// fits a long services label such as "Programmierung und Inbetriebnahme").
func shift(rows []document.Row) []document.Row {
	for i := range rows {
		rows[i].Cells = append([]document.Cell{{}}, rows[i].Cells...)
	}
	return rows
}

// zoneTables lists, per plan, the devices (catalog lines, not add-ons) per
// zone and category; plans without counted devices are skipped. Existing
// devices are not in the BOM and so not counted (D185).
func (c content) zoneTables() []document.Block {
	l := c.lang
	var out []document.Block
	for _, p := range c.bom.Plans {
		type catKey = uuid.UUID
		var cats []catKey
		catNames := map[catKey]string{}
		counts := map[string]map[catKey]int64{} // zone id or "" → category → count
		for _, g := range c.bom.Groups {
			for _, cat := range g.Categories {
				for _, k := range cat.Lines {
					ln := c.line(k)
					if ln.Kind != bom.KindCatalog {
						continue
					}
					add := func(zone string, n int64) {
						if n == 0 {
							return
						}
						if !slices.Contains(cats, cat.Category.ID) {
							cats = append(cats, cat.Category.ID)
							catNames[cat.Category.ID] = text(cat.Category.Name, l)
						}
						if counts[zone] == nil {
							counts[zone] = map[catKey]int64{}
						}
						counts[zone][cat.Category.ID] += n
					}
					for _, z := range p.Zones {
						add(z.ID.String(), ln.Quantities.Zones[z.ID.String()])
					}
					add("", ln.Quantities.Unzoned[p.ID.String()])
				}
			}
		}
		if len(cats) == 0 {
			continue
		}
		if len(cats) > maxZoneColumns {
			out = append(out, c.zoneTableByCategory(p, cats, catNames, counts))
			continue
		}
		cols := []document.Column{{Weight: 2.5}}
		head := []document.Cell{document.TextCell(p.Name)}
		right := document.AlignRight
		for _, id := range cats {
			cols = append(cols, document.Column{Weight: 1, Align: document.AlignRight})
			cell := document.TextCell(catNames[id])
			cell.Align = &right
			head = append(head, cell)
		}
		t := document.Table{Columns: cols, Rows: []document.Row{{Kind: document.HeaderRow, Cells: head}}}
		zoneRow := func(name, key string) {
			if len(counts[key]) == 0 {
				return
			}
			cells := []document.Cell{document.TextCell(name)}
			for _, id := range cats {
				s := ""
				if n := counts[key][id]; n > 0 {
					s = itoa64(n)
				}
				cells = append(cells, document.TextCell(s))
			}
			t.Rows = append(t.Rows, document.Row{Cells: cells})
		}
		for _, z := range p.Zones {
			zoneRow(z.Name, z.ID.String())
		}
		zoneRow(l.t("noZone"), "")
		out = append(out, t)
	}
	return out
}

// maxZoneColumns: with more categories a plan's zone summary lists the
// categories as rows and the zones as columns; with more zones too, a row
// per zone and category.
const maxZoneColumns = 5

// zoneTableByCategory is the transposed zone summary of a plan: a row per
// category, a column per zone with devices (and "No zone").
func (c content) zoneTableByCategory(p bom.BOMPlanRef, cats []uuid.UUID, catNames map[uuid.UUID]string, counts map[string]map[uuid.UUID]int64) document.Table {
	l := c.lang
	right := document.AlignRight
	type zone struct{ key, name string }
	var zones []zone
	for _, z := range p.Zones {
		if len(counts[z.ID.String()]) > 0 {
			zones = append(zones, zone{z.ID.String(), z.Name})
		}
	}
	if len(counts[""]) > 0 {
		zones = append(zones, zone{"", l.t("noZone")})
	}
	if len(zones) > maxZoneColumns {
		// Too many of both for a matrix: a zone heading row with its
		// devices, then a row per category (D271).
		t := document.Table{Columns: []document.Column{{Weight: 5}, {Weight: 1, Align: document.AlignRight}},
			Rows: []document.Row{{Kind: document.HeaderRow, Cells: []document.Cell{document.TextCell(p.Name), {Runs: []document.Run{{Text: l.t("quantity")}}, Align: &right}}}}}
		for _, z := range zones {
			var sum int64
			for _, n := range counts[z.key] {
				sum += n
			}
			t.Rows = append(t.Rows, document.Row{Kind: document.SubgroupRow, Cells: []document.Cell{document.TextCell(z.name), {Runs: []document.Run{{Text: itoa64(sum)}}, Align: &right}}})
			for _, id := range cats {
				if n := counts[z.key][id]; n > 0 {
					t.Rows = append(t.Rows, document.Row{Cells: []document.Cell{{Runs: []document.Run{{Text: catNames[id]}}, Indent: 1}, document.TextCell(itoa64(n))}})
				}
			}
		}
		return t
	}
	cols := []document.Column{{Weight: 2.5}}
	head := []document.Cell{document.TextCell(p.Name + " – " + l.t("category"))}
	for _, z := range zones {
		cols = append(cols, document.Column{Weight: 1, Align: document.AlignRight})
		cell := document.TextCell(z.name)
		cell.Align = &right
		head = append(head, cell)
	}
	t := document.Table{Columns: cols, Rows: []document.Row{{Kind: document.HeaderRow, Cells: head}}}
	for _, id := range cats {
		cells := []document.Cell{document.TextCell(catNames[id])}
		for _, z := range zones {
			s := ""
			if n := counts[z.key][id]; n > 0 {
				s = itoa64(n)
			}
			cells = append(cells, document.TextCell(s))
		}
		t.Rows = append(t.Rows, document.Row{Cells: cells})
	}
	return t
}

func (c content) line(key string) bom.BOMLine {
	for _, ln := range c.bom.Lines {
		if ln.Key == key {
			return ln
		}
	}
	return bom.BOMLine{}
}

// Landscape A4 text area: 257 × 170 mm minus header and heading.
const (
	planMaxWidthMM  = 257
	planMaxHeightMM = 128
)

func (c content) planSection(p planPage) document.Section {
	l := c.lang
	w := planMaxWidthMM
	h := float64(w) * float64(p.image.height) / float64(max(p.image.width, 1))
	wm := float64(w)
	if h > planMaxHeightMM {
		wm, h = wm*planMaxHeightMM/h, planMaxHeightMM
	}
	blocks := []document.Block{
		document.Heading{Level: 2, Text: p.name},
		document.Image{PNG: p.image.data, WidthMM: wm, HeightMM: h, Align: document.AlignCenter},
	}
	if len(p.legend) > 0 || p.existing {
		var parts []string
		for _, e := range p.legend {
			n := itoa(e.count)
			if e.existing > 0 {
				n = l.t("existingCount", e.count, e.existing)
			}
			parts = append(parts, e.name+" ("+n+")")
		}
		if p.existing {
			parts = append(parts, l.t("existing"))
		}
		blocks = append(blocks, document.Paragraph{Runs: []document.Run{{Text: l.t("legend") + ": ", Bold: true}, {Text: strings.Join(parts, " · ")}}, Style: document.Small})
	}
	return document.Section{Orientation: document.Landscape, Blocks: blocks}
}
