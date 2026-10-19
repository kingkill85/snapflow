// Package docx renders a document.Document as an Office Open XML word
// processing file (.docx), written directly with archive/zip and escaped
// XML text: A4 pages (portrait or landscape per section), one header and
// footer with page numbers, styles in Arial (present on Windows and macOS;
// LibreOffice substitutes the metric-compatible Liberation Sans), tables
// with borders, shading, repeated header rows, group rows and fixed column
// widths, and inline PNG images. Only the parts and attributes Word,
// LibreOffice and Google Docs need are written.
package docx

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"image/png"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/platform/document"
)

// Page geometry in twentieths of a point (twips).
const (
	a4Short   = 11906
	a4Long    = 16838
	margin    = 1134 // 2 cm
	headerGap = 567  // 1 cm from the edge
	emuPerMM  = 36000
)

// Exporter is the DOCX exporter.
type Exporter struct{}

func (Exporter) Key() string           { return "docx" }
func (Exporter) FileExtension() string { return "docx" }
func (Exporter) ContentType() string {
	return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}

func (Exporter) Name(language string) string {
	if language == "de" {
		return "Word-Dokument (DOCX)"
	}
	return "Word document (DOCX)"
}

// Render writes doc as a DOCX file.
func (Exporter) Render(ctx context.Context, doc document.Document) ([]byte, error) {
	w := &writer{doc: doc}
	return w.render(ctx)
}

// part is a file of the package with its relationships.
type part struct {
	media []media
}

type media struct {
	relID string
	name  string // word/media/<name>
	data  []byte
}

type writer struct {
	doc     document.Document
	images  int // global counter for media names and drawing ids
	parts   map[string]*part
	current *part
}

func (w *writer) render(ctx context.Context) ([]byte, error) {
	w.parts = map[string]*part{"document": {}, "header": {}, "footer": {}}
	var body strings.Builder
	w.current = w.parts["document"]
	sections := w.doc.Sections
	if len(sections) == 0 {
		sections = []document.Section{{}}
	}
	for i, s := range sections {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		width := textWidth(s.Orientation)
		for _, b := range s.Blocks {
			if err := w.block(&body, b, width); err != nil {
				return nil, err
			}
		}
		if len(s.Blocks) == 0 {
			body.WriteString(`<w:p/>`)
		}
		if i < len(sections)-1 {
			body.WriteString(`<w:p><w:pPr>` + sectPr(s.Orientation, w.doc.Header != nil, w.doc.Footer != nil) + `</w:pPr></w:p>`)
		} else {
			body.WriteString(sectPr(s.Orientation, w.doc.Header != nil, w.doc.Footer != nil))
		}
	}
	var header, footer string
	if w.doc.Header != nil {
		w.current = w.parts["header"]
		var b strings.Builder
		if err := w.block(&b, *w.doc.Header, textWidth(document.Portrait)); err != nil {
			return nil, err
		}
		if _, isPara := (*w.doc.Header).(document.Paragraph); !isPara {
			b.WriteString(`<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr></w:p>`) // a header must end with a paragraph
		}
		header = wrap("w:hdr", b.String())
	}
	if f := w.doc.Footer; f != nil {
		footer = wrap("w:ftr", footerXML(*f))
	}

	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	add := func(name, content string) error {
		fw, err := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
		if err != nil {
			return err
		}
		_, err = fw.Write([]byte(content))
		return err
	}
	files := []struct{ name, content string }{
		{"[Content_Types].xml", contentTypes(header != "", footer != "")},
		{"_rels/.rels", rootRels},
		{"docProps/core.xml", w.core()},
		{"docProps/app.xml", appXML},
		{"word/document.xml", wrap("w:document", `<w:body>`+body.String()+`</w:body>`)},
		{"word/styles.xml", w.styles()},
		{"word/settings.xml", settingsXML},
		{"word/_rels/document.xml.rels", w.documentRels(header != "", footer != "")},
	}
	if header != "" {
		files = append(files, struct{ name, content string }{"word/header1.xml", header},
			struct{ name, content string }{"word/_rels/header1.xml.rels", rels(w.parts["header"].media, "")})
	}
	if footer != "" {
		files = append(files, struct{ name, content string }{"word/footer1.xml", footer})
	}
	for _, f := range files {
		if err := add(f.name, xml.Header+f.content); err != nil {
			return nil, err
		}
	}
	for _, p := range []string{"document", "header"} {
		for _, m := range w.parts[p].media {
			fw, err := z.CreateHeader(&zip.FileHeader{Name: "word/media/" + m.name, Method: zip.Store})
			if err != nil {
				return nil, err
			}
			if _, err := fw.Write(m.data); err != nil {
				return nil, err
			}
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func textWidth(o document.Orientation) int {
	if o == document.Landscape {
		return a4Long - 2*margin
	}
	return a4Short - 2*margin
}

func sectPr(o document.Orientation, header, footer bool) string {
	var b strings.Builder
	b.WriteString(`<w:sectPr>`)
	if header {
		b.WriteString(`<w:headerReference w:type="default" r:id="rIdHeader1"/>`)
	}
	if footer {
		b.WriteString(`<w:footerReference w:type="default" r:id="rIdFooter1"/>`)
	}
	if o == document.Landscape {
		fmt.Fprintf(&b, `<w:pgSz w:w="%d" w:h="%d" w:orient="landscape"/>`, a4Long, a4Short)
	} else {
		fmt.Fprintf(&b, `<w:pgSz w:w="%d" w:h="%d"/>`, a4Short, a4Long)
	}
	top := margin
	if header {
		top = 2268 // 4 cm: room for the letterhead
	}
	fmt.Fprintf(&b, `<w:pgMar w:top="%d" w:right="%d" w:bottom="%d" w:left="%d" w:header="%d" w:footer="%d" w:gutter="0"/>`,
		top, margin, margin, margin, headerGap, headerGap)
	b.WriteString(`</w:sectPr>`)
	return b.String()
}

// ---------------------------------------------------------------- blocks

func (w *writer) block(b *strings.Builder, blk document.Block, width int) error {
	switch v := blk.(type) {
	case document.Heading:
		level := min(max(v.Level, 1), 3)
		fmt.Fprintf(b, `<w:p><w:pPr><w:pStyle w:val="Heading%d"/></w:pPr>%s</w:p>`, level, runs([]document.Run{{Text: v.Text}}))
	case document.Paragraph:
		b.WriteString(paragraph(v))
	case document.Spacer:
		b.WriteString(`<w:p/>`)
	case document.PageBreak:
		b.WriteString(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`)
	case document.Image:
		d, err := w.drawing(v)
		if err != nil {
			return err
		}
		fmt.Fprintf(b, `<w:p><w:pPr>%s</w:pPr><w:r>%s</w:r></w:p>`, jc(v.Align), d)
	case document.Table:
		return w.table(b, v, width)
	default:
		return fmt.Errorf("docx: unknown block %T", blk)
	}
	return nil
}

func paragraph(p document.Paragraph) string {
	style := ""
	switch p.Style {
	case document.Small:
		style = `<w:pStyle w:val="Small"/>`
	case document.Muted:
		style = `<w:pStyle w:val="Muted"/>`
	}
	return `<w:p><w:pPr>` + style + jc(p.Align) + `</w:pPr>` + runs(p.Runs) + `</w:p>`
}

func jc(a document.Align) string {
	switch a {
	case document.AlignCenter:
		return `<w:jc w:val="center"/>`
	case document.AlignRight:
		return `<w:jc w:val="right"/>`
	}
	return ""
}

func runs(rs []document.Run) string {
	var b strings.Builder
	for _, r := range rs {
		props := ""
		if r.Bold {
			props += `<w:b/>`
		}
		if r.Italic {
			props += `<w:i/>`
		}
		if props != "" {
			props = `<w:rPr>` + props + `</w:rPr>`
		}
		for i, line := range strings.Split(r.Text, "\n") {
			b.WriteString(`<w:r>` + props)
			if i > 0 {
				b.WriteString(`<w:br/>`)
			}
			if line != "" {
				b.WriteString(`<w:t xml:space="preserve">` + esc(line) + `</w:t>`)
			}
			b.WriteString(`</w:r>`)
		}
	}
	return b.String()
}

func (w *writer) table(b *strings.Builder, t document.Table, width int) error {
	if len(t.Columns) == 0 {
		return nil
	}
	total := 0.0
	for _, c := range t.Columns {
		total += math.Max(c.Weight, 0)
	}
	widths := make([]int, len(t.Columns))
	used := 0
	for i, c := range t.Columns {
		widths[i] = int(float64(width) * math.Max(c.Weight, 0) / math.Max(total, 1e-9))
		used += widths[i]
	}
	widths[len(widths)-1] += width - used

	b.WriteString(`<w:tbl><w:tblPr>`)
	fmt.Fprintf(b, `<w:tblW w:w="%d" w:type="dxa"/>`, width)
	if t.Borderless {
		b.WriteString(`<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>`)
	} else {
		b.WriteString(`<w:tblBorders>` +
			`<w:top w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>` +
			`<w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>` +
			`<w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>` +
			`<w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>` +
			`<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>` +
			`<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>` +
			`</w:tblBorders>`)
	}
	b.WriteString(`<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="85" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar>`)
	b.WriteString(`<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>`)
	b.WriteString(`</w:tblPr><w:tblGrid>`)
	for _, wd := range widths {
		fmt.Fprintf(b, `<w:gridCol w:w="%d"/>`, wd)
	}
	b.WriteString(`</w:tblGrid>`)
	for _, r := range t.Rows {
		b.WriteString(`<w:tr>`)
		switch r.Kind {
		case document.HeaderRow:
			b.WriteString(`<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>`)
		default:
			b.WriteString(`<w:trPr><w:cantSplit/></w:trPr>`)
		}
		col := 0
		for _, c := range r.Cells {
			if col >= len(widths) {
				break
			}
			span := max(c.Span, 1)
			span = min(span, len(widths)-col)
			cw := 0
			for _, wd := range widths[col : col+span] {
				cw += wd
			}
			align := t.Columns[col].Align
			if c.Align != nil {
				align = *c.Align
			}
			b.WriteString(`<w:tc><w:tcPr>`)
			fmt.Fprintf(b, `<w:tcW w:w="%d" w:type="dxa"/>`, cw)
			if span > 1 {
				fmt.Fprintf(b, `<w:gridSpan w:val="%d"/>`, span)
			}
			if !t.Borderless {
				switch r.Kind {
				case document.HeaderRow:
					b.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="DCE3EC"/>`)
				case document.GroupRow:
					b.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="EDF1F5"/>`)
				case document.SubgroupRow:
					b.WriteString(`<w:shd w:val="clear" w:color="auto" w:fill="F7F8FA"/>`)
				case document.TotalRow:
					b.WriteString(`<w:tcBorders><w:top w:val="single" w:sz="8" w:space="0" w:color="595959"/></w:tcBorders>`)
				}
			}
			b.WriteString(`</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/>`)
			if c.Indent > 0 {
				fmt.Fprintf(b, `<w:ind w:left="%d"/>`, 284*c.Indent)
			}
			b.WriteString(jc(align))
			b.WriteString(`</w:pPr>`)
			if c.Image != nil {
				d, err := w.drawing(*c.Image)
				if err != nil {
					return err
				}
				b.WriteString(`<w:r>` + d + `</w:r>`)
			} else {
				rs := c.Runs
				if r.Kind == document.HeaderRow || r.Kind == document.GroupRow || r.Kind == document.TotalRow {
					rs = bold(rs)
				}
				b.WriteString(runs(rs))
			}
			b.WriteString(`</w:p></w:tc>`)
			col += span
		}
		// Every row needs a cell per grid column.
		for ; col < len(widths); col++ {
			fmt.Fprintf(b, `<w:tc><w:tcPr><w:tcW w:w="%d" w:type="dxa"/></w:tcPr><w:p/></w:tc>`, widths[col])
		}
		b.WriteString(`</w:tr>`)
	}
	b.WriteString(`</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`)
	return nil
}

func bold(rs []document.Run) []document.Run {
	out := make([]document.Run, len(rs))
	for i, r := range rs {
		r.Bold = true
		out[i] = r
	}
	return out
}

// drawing adds a PNG to the current part and returns its inline drawing.
func (w *writer) drawing(img document.Image) (string, error) {
	if _, err := png.DecodeConfig(bytes.NewReader(img.PNG)); err != nil {
		return "", fmt.Errorf("docx: image is not a PNG: %w", err)
	}
	w.images++
	n := w.images
	rel := "rIdImage" + strconv.Itoa(n)
	name := "image" + strconv.Itoa(n) + ".png"
	w.current.media = append(w.current.media, media{relID: rel, name: name, data: img.PNG})
	cx, cy := int64(img.WidthMM*emuPerMM), int64(img.HeightMM*emuPerMM)
	return fmt.Sprintf(`<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`+
		`<wp:extent cx="%d" cy="%d"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`+
		`<wp:docPr id="%d" name="Picture %d"/>`+
		`<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>`+
		`<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`+
		`<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`+
		`<pic:nvPicPr><pic:cNvPr id="%d" name="%s"/><pic:cNvPicPr/></pic:nvPicPr>`+
		`<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`+
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`+
		`</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`,
		cx, cy, n, n, n, name, rel, cx, cy), nil
}

func footerXML(f document.Footer) string {
	var b strings.Builder
	b.WriteString(`<w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="` + strconv.Itoa(textWidth(document.Portrait)) + `"/></w:tabs></w:pPr>`)
	b.WriteString(runs([]document.Run{{Text: f.Text}}))
	if f.PageLabel != "" {
		b.WriteString(`<w:r><w:tab/></w:r>`)
		rest := f.PageLabel
		for rest != "" {
			i := strings.IndexByte(rest, '{')
			if i < 0 {
				b.WriteString(runs([]document.Run{{Text: rest}}))
				break
			}
			b.WriteString(runs([]document.Run{{Text: rest[:i]}}))
			rest = rest[i:]
			switch {
			case strings.HasPrefix(rest, "{page}"):
				b.WriteString(`<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>`)
				rest = rest[len("{page}"):]
			case strings.HasPrefix(rest, "{pages}"):
				b.WriteString(`<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>`)
				rest = rest[len("{pages}"):]
			default:
				b.WriteString(runs([]document.Run{{Text: "{"}}))
				rest = rest[1:]
			}
		}
	}
	b.WriteString(`</w:p>`)
	return b.String()
}

// ---------------------------------------------------------------- package parts

const nsAttrs = ` xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
	` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
	` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`

func wrap(root, inner string) string {
	return "<" + root + nsAttrs + ">" + inner + "</" + root + ">"
}

func esc(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

const (
	relDoc      = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
	relCore     = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties"
	relApp      = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties"
	relStyles   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
	relSettings = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings"
	relHeader   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"
	relFooter   = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"
	relImage    = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
	ctMain      = "application/vnd.openxmlformats-officedocument.wordprocessingml"
)

const rootRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
	`<Relationship Id="rId1" Type="` + relDoc + `" Target="word/document.xml"/>` +
	`<Relationship Id="rId2" Type="` + relCore + `" Target="docProps/core.xml"/>` +
	`<Relationship Id="rId3" Type="` + relApp + `" Target="docProps/app.xml"/>` +
	`</Relationships>`

const appXML = `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SnapFlow</Application></Properties>`

const settingsXML = `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
	`<w:defaultTabStop w:val="709"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat>` +
	`<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>` +
	`</w:compat></w:settings>`

func contentTypes(header, footer bool) string {
	var b strings.Builder
	b.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`)
	b.WriteString(`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`)
	b.WriteString(`<Default Extension="xml" ContentType="application/xml"/>`)
	b.WriteString(`<Default Extension="png" ContentType="image/png"/>`)
	b.WriteString(`<Override PartName="/word/document.xml" ContentType="` + ctMain + `.document.main+xml"/>`)
	b.WriteString(`<Override PartName="/word/styles.xml" ContentType="` + ctMain + `.styles+xml"/>`)
	b.WriteString(`<Override PartName="/word/settings.xml" ContentType="` + ctMain + `.settings+xml"/>`)
	if header {
		b.WriteString(`<Override PartName="/word/header1.xml" ContentType="` + ctMain + `.header+xml"/>`)
	}
	if footer {
		b.WriteString(`<Override PartName="/word/footer1.xml" ContentType="` + ctMain + `.footer+xml"/>`)
	}
	b.WriteString(`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`)
	b.WriteString(`<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`)
	b.WriteString(`</Types>`)
	return b.String()
}

func rels(ms []media, extra string) string {
	var b strings.Builder
	b.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	b.WriteString(extra)
	for _, m := range ms {
		b.WriteString(`<Relationship Id="` + m.relID + `" Type="` + relImage + `" Target="media/` + m.name + `"/>`)
	}
	b.WriteString(`</Relationships>`)
	return b.String()
}

func (w *writer) documentRels(header, footer bool) string {
	extra := `<Relationship Id="rIdStyles" Type="` + relStyles + `" Target="styles.xml"/>` +
		`<Relationship Id="rIdSettings" Type="` + relSettings + `" Target="settings.xml"/>`
	if header {
		extra += `<Relationship Id="rIdHeader1" Type="` + relHeader + `" Target="header1.xml"/>`
	}
	if footer {
		extra += `<Relationship Id="rIdFooter1" Type="` + relFooter + `" Target="footer1.xml"/>`
	}
	return rels(w.parts["document"].media, extra)
}

func (w *writer) core() string {
	return `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
		` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
		` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		`<dc:title>` + esc(w.doc.Title) + `</dc:title>` +
		`<dc:creator>` + esc(w.doc.Author) + `</dc:creator>` +
		`<dc:language>` + esc(w.doc.Language) + `</dc:language>` +
		`</cp:coreProperties>`
}

func (w *writer) styles() string {
	lang := w.doc.Language
	if lang == "" {
		lang = "en"
	}
	font := `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>`
	return `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:docDefaults><w:rPrDefault><w:rPr>` + font + `<w:sz w:val="19"/><w:szCs w:val="19"/><w:lang w:val="` + esc(lang) + `"/></w:rPr></w:rPrDefault>` +
		`<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
		`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
		heading(1, 36, "1F3B57", 240) + heading(2, 26, "1F3B57", 200) + heading(3, 21, "333333", 160) +
		`<w:style w:type="paragraph" w:customStyle="1" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>` +
		`<w:style w:type="paragraph" w:customStyle="1" w:styleId="Muted"><w:name w:val="Muted"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="666666"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>` +
		`<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>` +
		`<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="666666"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>` +
		`<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
		`</w:styles>`
}

func heading(level, size int, color string, before int) string {
	return fmt.Sprintf(`<w:style w:type="paragraph" w:styleId="Heading%d"><w:name w:val="heading %d"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>`+
		`<w:pPr><w:keepNext/><w:spacing w:before="%d" w:after="120"/><w:outlineLvl w:val="%d"/></w:pPr>`+
		`<w:rPr><w:b/><w:color w:val="%s"/><w:sz w:val="%d"/><w:szCs w:val="%d"/></w:rPr></w:style>`,
		level, level, before, level-1, color, size, size)
}
