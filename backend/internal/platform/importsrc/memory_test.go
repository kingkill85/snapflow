package importsrc_test

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc"
)

// Bounded memory with hostile workbooks (zip parts that expand, many
// anchors on one picture, cells far to the right) and no temporary files.

type part struct{ name, body string }

// rawXLSX builds a minimal workbook with one sheet around the given sheet
// XML, plus extra parts.
func rawXLSX(t *testing.T, sheet string, extra ...part) []byte {
	t.Helper()
	parts := []part{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`},
		{"xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t xml:space="preserve"> Model </t></si><si><r><t>Rich </t></r><r><rPr><b/></rPr><t>text</t></r><rPh><t>phonetic</t></rPh></si><si><t>Line_x000D_break</t></si></sst>`},
		{"xl/worksheets/sheet1.xml", sheet},
	}
	parts = append(parts, extra...)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, p := range parts {
		w, err := zw.Create(p.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(p.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sheetXML(rows string, extra string) string {
	return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>` + rows + `</sheetData>` + extra + `</worksheet>`
}

// allocated runs f and returns the bytes it allocated.
func allocated(f func()) uint64 {
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

var bigLimits = importsrc.Limits{MaxRows: 21_000, MaxColumns: 1000, MaxImages: 5000, MaxImageBytes: 10 << 20, MaxImageTotal: 256 << 20}

func readTable(t *testing.T, data []byte, limits importsrc.Limits) (*importsrc.Table, error) {
	t.Helper()
	src, err := importsrc.Open("a.xlsx", data, limits, importsrc.Options{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = src.Close() }()
	return src.Table("")
}

// Cell types come from the sheet itself: shared strings (runs joined,
// phonetic runs left out, _xHHHH_ escapes), inline strings, numbers cleaned
// like the General format, text that looks like a number kept, booleans,
// formula results; cells by their reference.
func TestXLSXCells(t *testing.T) {
	rows := `<row r="2"><c r="B2" t="s"><v>0</v></c><c r="D2" t="s"><v>1</v></c><c r="E2" t="s"><v>2</v></c></row>` +
		`<row><c r="A3" t="inlineStr"><is><t>1.10</t></is></c><c r="B3"><v>27.499999999999996</v></c><c r="C3" t="b"><v>1</v></c>` +
		`<c r="D3" t="str"><f>A1</f><v>x.5</v></c><c r="E3" s="1"/><c><v>1E-3</v></c></row>`
	tbl, err := readTable(t, rawXLSX(t, sheetXML(rows, "")), bigLimits)
	if err != nil {
		t.Fatal(err)
	}
	got := map[int][]string{}
	for _, r := range tbl.Rows {
		got[r.Number] = r.Cells
	}
	want := map[int][]string{
		2: {"", " Model ", "", "Rich text", "Line\rbreak"},
		3: {"1.10", "27.5", "1", "x.5", "", "0.001"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cells %v", got)
	}
}

// One 8 MB picture part anchored 400 times: nothing is read while the
// table is built, and the picture counts once towards the total.
func TestXLSXPictureAnchoredOften(t *testing.T) {
	const anchors = 400
	var a strings.Builder
	for i := range anchors {
		fmt.Fprintf(&a, `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>%d</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1" cy="1"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="%d" name="p"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`, i, i+2)
	}
	drawing := func(media string) []part {
		return []part{
			{"xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`},
			{"xl/drawings/drawing1.xml", `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` + a.String() + `</xdr:wsDr>`},
			{"xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`},
			{"xl/media/image1.png", media},
		}
	}
	data := rawXLSX(t, sheetXML(`<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`, `<drawing r:id="rId1"/>`), drawing(strings.Repeat("\x00", 8<<20))...)
	var (
		tbl *importsrc.Table
		err error
	)
	n := allocated(func() { tbl, err = readTable(t, data, bigLimits) })
	if err != nil {
		t.Fatal(err)
	}
	if tbl.Images != anchors || tbl.Rows[0].Images[0].Size != 8<<20 {
		t.Errorf("images %d, size %d", tbl.Images, tbl.Rows[0].Images[0].Size)
	}
	if n > 32<<20 {
		t.Errorf("reading the table allocated %d MB", n>>20)
	}
	// The total counts each picture once: 8 MB is within 10 MB.
	limits := bigLimits
	limits.MaxImageTotal = 10 << 20
	if _, err := readTable(t, data, limits); err != nil {
		t.Errorf("one picture within the total: %v", err)
	}
	limits.MaxImageTotal = 4 << 20
	if _, err := readTable(t, data, limits); err == nil || code(t, err) != "import.images_too_large" {
		t.Errorf("total: %v", err)
	}
}

// Rows with a cell in column XFD: import.too_many_columns before any row
// is kept, without allocating the 16 384 columns of each row.
func TestXLSXWideRows(t *testing.T) {
	var rows strings.Builder
	for i := 1; i <= 20_000; i++ {
		fmt.Fprintf(&rows, `<row r="%d"><c r="XFD%d" t="inlineStr"><is><t>x</t></is></c></row>`, i, i)
	}
	data := rawXLSX(t, sheetXML(rows.String(), ""))
	var err error
	n := allocated(func() { _, err = readTable(t, data, bigLimits) })
	if err == nil || code(t, err) != "import.too_many_columns" {
		t.Fatalf("wide rows: %v", err)
	}
	if n > 16<<20 {
		t.Errorf("allocated %d MB", n>>20)
	}
	// Formatted empty cells far to the right are not columns.
	data = rawXLSX(t, sheetXML(`<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="XFD1" s="1"/></row>`, ""))
	if tbl, err := readTable(t, data, bigLimits); err != nil || len(tbl.Rows[0].Cells) != 1 {
		t.Errorf("empty cell far right: %v", err)
	}
}

// A worksheet far above 64 MB unpacked is streamed: no temporary files are
// left (or written), and memory stays bounded.
func TestXLSXBigSheetNoTempFiles(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	big := strings.Repeat("a", 32_000)
	var rows strings.Builder
	for i := 1; i <= 2200; i++ {
		fmt.Fprintf(&rows, `<row r="%d"><c r="A%d" t="inlineStr"><is><t>%s</t></is></c></row>`, i, i, big)
	}
	sheet := sheetXML(rows.String(), "")
	data := rawXLSX(t, sheet)
	tbl, err := readTable(t, data, bigLimits)
	if err != nil || len(tbl.Rows) != 2200 {
		t.Fatalf("%v", err)
	}
	var left []string
	_ = filepath.Walk(tmp, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			left = append(left, filepath.Base(p))
		}
		return nil
	})
	if len(sheet) < 64<<20 || len(left) > 0 {
		t.Errorf("sheet %d MB, temporary files left: %v", len(sheet)>>20, left)
	}
}

// 20 000 rows of 10 decimal numbers: numbers are cleaned from the cell's
// own type, without loading the sheet into a model.
func TestXLSXManyNumbers(t *testing.T) {
	var rows strings.Builder
	for i := 1; i <= 20_000; i++ {
		fmt.Fprintf(&rows, `<row r="%d">`, i)
		for c := range 10 {
			fmt.Fprintf(&rows, `<c r="%s%d"><v>%d.25</v></c>`, importsrc.ColumnName(c), i, i)
		}
		rows.WriteString(`</row>`)
	}
	data := rawXLSX(t, sheetXML(rows.String(), `<mergeCells count="1"><mergeCell ref="L1:M1"/></mergeCells>`))
	var (
		tbl *importsrc.Table
		err error
	)
	n := allocated(func() { tbl, err = readTable(t, data, bigLimits) })
	if err != nil || len(tbl.Rows) != 20_000 || tbl.Rows[19_999].Cell(9) != "20000.25" {
		t.Fatalf("%v", err)
	}
	// Bounded by the decoder's tokens: the old reader allocated 443 MB.
	if n > 300<<20 {
		t.Errorf("allocated %d MB", n>>20)
	}
}
