package document

import "strings"

// Letterhead is the tenant's letterhead of a document (D261): the company
// name, address and contact lines, and an optional logo (PNG with its
// pixel size).
type Letterhead struct {
	Company, Address, Phone, Email, Website string
	LogoPNG                                 []byte
	LogoWidth, LogoHeight                   int
}

// maxContactLine: characters of "phone · email · website" that fit the
// letterhead's text column (about 120 mm at 9.5 pt) on one line.
const maxContactLine = 75

// Compact: only the company name, so a one-line header suffices.
func (l Letterhead) Compact() bool {
	return l.LogoPNG == nil && l.Address == "" && l.Phone == "" && l.Email == "" && l.Website == ""
}

// Header is the page header block of the letterhead: logo left, company
// and contact lines right.
func (l Letterhead) Header() *Block {
	lines := []Run{{Text: l.Company, Bold: true}}
	if l.Address != "" {
		lines = append(lines, Run{Text: "\n" + l.Address})
	}
	var contact []string
	for _, s := range []string{l.Phone, l.Email, l.Website} {
		if s != "" {
			contact = append(contact, s)
		}
	}
	// One line when it fits the column, else a line each (a wrapped
	// website or email breaks at its hyphens, D271).
	if joined := strings.Join(contact, " · "); len([]rune(joined)) <= maxContactLine {
		if joined != "" {
			lines = append(lines, Run{Text: "\n" + joined})
		}
	} else {
		for _, s := range contact {
			lines = append(lines, Run{Text: "\n" + s})
		}
	}
	right := Cell{Runs: lines}
	left := Cell{}
	if l.LogoPNG != nil {
		// At most 45 × 18 mm, aspect kept.
		w, h := 45.0, 45.0*float64(l.LogoHeight)/float64(max(l.LogoWidth, 1))
		if h > 18 {
			w, h = w*18/h, 18
		}
		left.Image = &Image{PNG: l.LogoPNG, WidthMM: w, HeightMM: h}
	}
	var b Block = Table{Borderless: true, Columns: []Column{{Weight: 1}, {Weight: 2.4, Align: AlignRight}},
		Rows: []Row{{Cells: []Cell{left, right}}}}
	return &b
}
