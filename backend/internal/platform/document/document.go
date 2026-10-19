// Package document is the format-neutral document model of SnapFlow's
// exports (proposals first, spec 2d): sections with an orientation, headings,
// paragraphs of runs, tables (column weights, header, group and total rows,
// alignment, spans), images (PNG bytes and a size), page breaks, and one
// header and footer for every page. It knows nothing about HTML, OOXML or
// PDF; an Exporter turns a Document into a file.
package document

import (
	"context"
	"slices"
	"sort"
)

// Orientation of a section's pages (A4).
type Orientation int

const (
	Portrait Orientation = iota
	Landscape
)

// Align is the horizontal alignment of a paragraph or cell.
type Align int

const (
	AlignLeft Align = iota
	AlignCenter
	AlignRight
)

// Document is a whole document.
type Document struct {
	Title    string
	Language string // BCP 47, e.g. "en", "de"
	Author   string
	// Header and Footer repeat on every page of every section; nil for none.
	Header *Block
	Footer *Footer
	// CompactHeader: the header is a single line (e.g. only a company name),
	// so pages start 2 cm from the top instead of 4 cm.
	CompactHeader bool
	// Sections in order; each starts on a new page.
	Sections []Section
}

// Footer is the page footer: optional text and the page number.
type Footer struct {
	Text string
	// PageLabel formats the page number: "{page}" and "{pages}" are
	// replaced by the current page and the page count, e.g. "Page {page} of
	// {pages}". Empty: no page number.
	PageLabel string
}

// Section is a run of pages with one orientation.
type Section struct {
	Orientation Orientation
	Blocks      []Block
}

// Block is one of Heading, Paragraph, Table, Image, PageBreak or Spacer.
type Block interface{ block() }

// Heading is a heading of level 1 (title) to 3.
type Heading struct {
	Level int
	Text  string
}

// ParagraphStyle is the look of a paragraph.
type ParagraphStyle int

const (
	Normal ParagraphStyle = iota
	Small                 // smaller text, e.g. footnotes
	Muted                 // smaller grey text
)

// Paragraph is text in runs; "\n" in a run is a line break.
type Paragraph struct {
	Runs  []Run
	Align Align
	Style ParagraphStyle
}

// Text is a paragraph of plain text.
func Text(s string) Paragraph { return Paragraph{Runs: []Run{{Text: s}}} }

// Run is text with one formatting.
type Run struct {
	Text   string
	Bold   bool
	Italic bool
}

// Column is a table column.
type Column struct {
	// Weight is the column's share of the table width (relative to the
	// other columns).
	Weight float64
	Align  Align
}

// RowKind is the role of a table row.
type RowKind int

const (
	BodyRow     RowKind = iota
	HeaderRow           // repeated on every page, shaded, bold
	GroupRow            // a group heading, shaded, bold
	SubgroupRow         // a second-level group heading, lightly shaded
	TotalRow            // a totals row, bold, with a line above
)

// Row is a table row.
type Row struct {
	Kind  RowKind
	Cells []Cell
}

// Cell is a table cell.
type Cell struct {
	Runs []Run
	// Span is the number of columns the cell covers (0 and 1: one).
	Span int
	// Align overrides the column's alignment when set.
	Align *Align
	// Indent is the left indent in levels (e.g. add-on lines).
	Indent int
	// Image is shown instead of the runs when set.
	Image *Image
}

// TextCell is a cell with plain text.
func TextCell(s string) Cell { return Cell{Runs: []Run{{Text: s}}} }

// Table is a table across the section's text width.
type Table struct {
	Columns []Column
	Rows    []Row
	// Borderless tables (layout, e.g. the letterhead) have no lines or
	// shading.
	Borderless bool
}

// Image is a PNG image shown at a size in millimetres.
type Image struct {
	PNG               []byte
	WidthMM, HeightMM float64
	Align             Align
}

// PageBreak starts a new page.
type PageBreak struct{}

// Spacer is vertical space of one empty line.
type Spacer struct{}

func (Heading) block()   {}
func (Paragraph) block() {}
func (Table) block()     {}
func (Image) block()     {}
func (PageBreak) block() {}
func (Spacer) block()    {}

// Exporter turns a document into a file of one format.
type Exporter interface {
	// Key identifies the exporter in the API ("docx").
	Key() string
	// Name is the format's display name in a language.
	Name(language string) string
	ContentType() string
	// FileExtension without the dot ("docx").
	FileExtension() string
	Render(ctx context.Context, doc Document) ([]byte, error)
}

// Registry holds the available exporters.
type Registry struct {
	byKey map[string]Exporter
}

// NewRegistry returns a registry of exporters.
func NewRegistry(exporters ...Exporter) *Registry {
	r := &Registry{byKey: map[string]Exporter{}}
	for _, e := range exporters {
		r.byKey[e.Key()] = e
	}
	return r
}

// Get returns the exporter with key.
func (r *Registry) Get(key string) (Exporter, bool) {
	e, ok := r.byKey[key]
	return e, ok
}

// All returns the exporters sorted by key.
func (r *Registry) All() []Exporter {
	keys := make([]string, 0, len(r.byKey))
	for k := range r.byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]Exporter, len(keys))
	for i, k := range keys {
		out[i] = r.byKey[k]
	}
	return out
}

// Keys returns the exporter keys, sorted.
func (r *Registry) Keys() []string {
	keys := make([]string, 0, len(r.byKey))
	for k := range r.byKey {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
