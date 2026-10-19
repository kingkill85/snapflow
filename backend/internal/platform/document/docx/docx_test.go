package docx_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/document/docx"
	"github.com/kingkill85/snapflow/backend/internal/platform/document/docx/docxtest"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		img.Set(x, h/2, color.RGBA{200, 0, 0, 255})
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sample(t *testing.T) document.Document {
	right := document.AlignRight
	return document.Document{
		Title: "Proposal 2026-0007-V1-01", Language: "de", Author: "Acme & Co",
		Header: ptr(document.Block(document.Table{Borderless: true, Columns: []document.Column{{Weight: 1}, {Weight: 2, Align: document.AlignRight}}, Rows: []document.Row{{
			Cells: []document.Cell{{Image: &document.Image{PNG: pngBytes(t, 40, 20), WidthMM: 30, HeightMM: 15}}, document.TextCell("Acme GmbH\nMain St 1")},
		}}})),
		Footer: &document.Footer{Text: "Acme GmbH", PageLabel: "Seite {page} von {pages}"},
		Sections: []document.Section{
			{Blocks: []document.Block{
				document.Heading{Level: 1, Text: "Angebot <2026> & „Test“"},
				document.Paragraph{Runs: []document.Run{{Text: "bold", Bold: true}, {Text: " italic\nnext line", Italic: true}}},
				document.Table{Columns: []document.Column{{Weight: 1}, {Weight: 5}, {Weight: 2, Align: document.AlignRight}}, Rows: []document.Row{
					{Kind: document.HeaderRow, Cells: []document.Cell{document.TextCell("#"), document.TextCell("Description"), document.TextCell("Total")}},
					{Kind: document.GroupRow, Cells: []document.Cell{{Runs: []document.Run{{Text: "Zigbee"}}, Span: 2}, {Runs: []document.Run{{Text: "1,234.50"}}, Align: &right}}},
					{Cells: []document.Cell{document.TextCell("1"), {Runs: []document.Run{{Text: "for Dimmer"}}, Indent: 1}, document.TextCell("12.00")}},
					{Kind: document.TotalRow, Cells: []document.Cell{{Runs: []document.Run{{Text: "Total"}}, Span: 2}, document.TextCell("12.00")}},
				}},
				document.Paragraph{Runs: []document.Run{{Text: "Footnote"}}, Style: document.Small},
			}},
			{Orientation: document.Landscape, Blocks: []document.Block{
				document.Heading{Level: 2, Text: "Plan EG"},
				document.Image{PNG: pngBytes(t, 300, 200), WidthMM: 240, HeightMM: 160, Align: document.AlignCenter},
			}},
		},
	}
}

func ptr[T any](v T) *T { return &v }

func render(t *testing.T, doc document.Document) []byte {
	t.Helper()
	data, err := docx.Exporter{}.Render(context.Background(), doc)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func unzip(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]byte{}
	for _, f := range z.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(r)
		out[f.Name] = b
	}
	return out
}

func wellFormed(t *testing.T, name string, data []byte) {
	t.Helper()
	d := xml.NewDecoder(bytes.NewReader(data))
	for {
		_, err := d.Token()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			t.Fatalf("%s is not well-formed: %v", name, err)
		}
	}
}

type relationships struct {
	Rels []struct {
		ID     string `xml:"Id,attr"`
		Type   string `xml:"Type,attr"`
		Target string `xml:"Target,attr"`
	} `xml:"Relationship"`
}

type contentTypes struct {
	Defaults []struct {
		Ext string `xml:"Extension,attr"`
	} `xml:"Default"`
	Overrides []struct {
		Part string `xml:"PartName,attr"`
	} `xml:"Override"`
}

func TestPackage(t *testing.T) {
	parts := unzip(t, render(t, sample(t)))
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml",
		"word/settings.xml", "word/_rels/document.xml.rels", "word/header1.xml", "word/_rels/header1.xml.rels",
		"word/footer1.xml", "docProps/core.xml", "docProps/app.xml", "word/media/image1.png", "word/media/image2.png"} {
		if _, ok := parts[name]; !ok {
			t.Errorf("missing part %s", name)
		}
	}
	for name, data := range parts {
		if strings.HasSuffix(name, ".xml") || strings.HasSuffix(name, ".rels") {
			wellFormed(t, name, data)
		}
	}
	// Every part is typed: by an override or its extension's default.
	var ct contentTypes
	if err := xml.Unmarshal(parts["[Content_Types].xml"], &ct); err != nil {
		t.Fatal(err)
	}
	typed := map[string]bool{}
	for _, o := range ct.Overrides {
		typed[strings.TrimPrefix(o.Part, "/")] = true
		if _, ok := parts[strings.TrimPrefix(o.Part, "/")]; !ok {
			t.Errorf("content type override for missing part %s", o.Part)
		}
	}
	defaults := map[string]bool{}
	for _, d := range ct.Defaults {
		defaults[d.Ext] = true
	}
	for name := range parts {
		if name == "[Content_Types].xml" || typed[name] {
			continue
		}
		if !defaults[filepath.Ext(name)[1:]] {
			t.Errorf("part %s has no content type", name)
		}
	}
	// Every relationship target exists; ids referenced in a part exist.
	for relPart, base := range map[string]string{"_rels/.rels": "", "word/_rels/document.xml.rels": "word/", "word/_rels/header1.xml.rels": "word/"} {
		var rs relationships
		if err := xml.Unmarshal(parts[relPart], &rs); err != nil {
			t.Fatal(err)
		}
		owner := map[string]string{"word/_rels/document.xml.rels": "word/document.xml", "word/_rels/header1.xml.rels": "word/header1.xml"}[relPart]
		for _, r := range rs.Rels {
			if _, ok := parts[base+r.Target]; !ok {
				t.Errorf("%s: target %s missing", relPart, r.Target)
			}
		}
		if owner != "" {
			for _, id := range refs(string(parts[owner])) {
				found := false
				for _, r := range rs.Rels {
					found = found || r.ID == id
				}
				if !found {
					t.Errorf("%s references %s, which %s does not define", owner, id, relPart)
				}
			}
		}
	}
	doc := string(parts["word/document.xml"])
	for _, want := range []string{
		`w:orient="landscape"`, `<w:pgSz w:w="11906" w:h="16838"/>`, `<w:tblHeader/>`, `<w:gridSpan w:val="2"/>`,
		`<w:jc w:val="right"/>`, `w:fill="EDF1F5"`, `<w:ind w:left="284"/>`, `<w:headerReference w:type="default" r:id="rIdHeader1"/>`,
		`Angebot &lt;2026&gt; &amp; „Test“`, `<w:br/>`, `<w:b/>`, `<w:i/>`, `<w:pStyle w:val="Small"/>`, `r:embed="rIdImage1"`,
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("document.xml lacks %s", want)
		}
	}
	// Two sections: one sectPr inside a paragraph, one at the end of the body.
	if n := strings.Count(doc, "<w:sectPr>"); n != 2 {
		t.Errorf("%d sections, want 2", n)
	}
	if !strings.HasSuffix(doc, "</w:sectPr></w:body></w:document>") {
		t.Error("the body must end with the last section's properties")
	}
	footer := string(parts["word/footer1.xml"])
	if !strings.Contains(footer, `w:instr=" PAGE "`) || !strings.Contains(footer, `w:instr=" NUMPAGES "`) || !strings.Contains(footer, "Seite ") {
		t.Errorf("footer lacks the page numbers: %s", footer)
	}
	if !strings.Contains(string(parts["word/header1.xml"]), "rIdImage2") {
		t.Error("the header's logo is not embedded")
	}
	if !strings.Contains(string(parts["word/styles.xml"]), `w:val="de"`) {
		t.Error("the document language is not set")
	}
}

func refs(s string) []string {
	var out []string
	for _, attr := range []string{`r:id="`, `r:embed="`} {
		rest := s
		for {
			i := strings.Index(rest, attr)
			if i < 0 {
				break
			}
			rest = rest[i+len(attr):]
			out = append(out, rest[:strings.IndexByte(rest, '"')])
		}
	}
	return out
}

func TestMinimal(t *testing.T) {
	parts := unzip(t, render(t, document.Document{}))
	if _, ok := parts["word/header1.xml"]; ok {
		t.Error("no header part without a header")
	}
	if strings.Contains(string(parts["[Content_Types].xml"]), "header") {
		t.Error("no header content type without a header")
	}
	wellFormed(t, "document", parts["word/document.xml"])
}

func TestRejectsNonPNG(t *testing.T) {
	_, err := docx.Exporter{}.Render(context.Background(), document.Document{Sections: []document.Section{{Blocks: []document.Block{
		document.Image{PNG: []byte("nope"), WidthMM: 10, HeightMM: 10},
	}}}})
	if err == nil {
		t.Fatal("want an error for a non-PNG image")
	}
}

// TestLibreOffice converts a generated file (letterhead with a logo, images,
// portrait and landscape sections) to PDF when LibreOffice is installed: not
// in the default dev shell, but in the "documents" one CI runs it in with
// REQUIRE_SOFFICE=1 (then a missing soffice fails the test).
func TestLibreOffice(t *testing.T) {
	soffice := docxtest.Soffice(t)
	docxtest.ConvertToPDF(t, soffice, map[string][]byte{"sample.docx": render(t, sample(t))})
}

// TestMediaHaveSizesInLocalHeaders: a stored entry whose sizes only follow
// its data (data descriptor, flag 0x8) cannot be read by LibreOffice.
func TestMediaHaveSizesInLocalHeaders(t *testing.T) {
	data := render(t, sample(t))
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	media := 0
	for _, f := range zr.File {
		if f.Method == zip.Store && f.Flags&0x8 != 0 {
			t.Errorf("%s: stored with a data descriptor", f.Name)
		}
		if strings.HasPrefix(f.Name, "word/media/") {
			media++
			off, err := f.DataOffset()
			if err != nil {
				t.Fatal(err)
			}
			// The local header's sizes (offset 18 and 22 from its start;
			// the header ends 30 + name length bytes in).
			start := off - 30 - int64(len(f.Name))
			size := uint32(data[start+22]) | uint32(data[start+23])<<8 | uint32(data[start+24])<<16 | uint32(data[start+25])<<24
			if size == 0 || uint64(size) != f.UncompressedSize64 {
				t.Errorf("%s: local header size %d, want %d", f.Name, size, f.UncompressedSize64)
			}
		}
	}
	if media == 0 {
		t.Fatal("no media")
	}
}

func TestNoBreakHyphens(t *testing.T) {
	parts := unzip(t, render(t, document.Document{Sections: []document.Section{{Blocks: []document.Block{
		document.Paragraph{Runs: []document.Run{{Text: "ZB-DIM-200", NoBreakHyphens: true}, {Text: " a-b"}}},
	}}}}))
	doc := string(parts["word/document.xml"])
	wellFormed(t, "word/document.xml", parts["word/document.xml"])
	if !strings.Contains(doc, `<w:t xml:space="preserve">ZB</w:t><w:noBreakHyphen/><w:t xml:space="preserve">DIM</w:t><w:noBreakHyphen/>`) || !strings.Contains(doc, " a-b<") {
		t.Errorf("hyphens: %s", doc)
	}
}
