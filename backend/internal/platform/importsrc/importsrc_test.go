package importsrc_test

import (
	"bytes"
	"errors"
	"image/color"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc/importsrctest"
)

var limits = importsrc.Limits{MaxRows: 100, MaxImages: 10, MaxImageBytes: 1 << 20}

func code(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("not an apperr: %v", err)
	}
	return ae.Code
}

func TestColumns(t *testing.T) {
	for col, name := range map[int]string{0: "A", 1: "B", 25: "Z", 26: "AA", 27: "AB", 701: "ZZ", 702: "AAA"} {
		if got := importsrc.ColumnName(col); got != name {
			t.Errorf("ColumnName(%d) = %s, want %s", col, got, name)
		}
		if got, ok := importsrc.ColumnIndex(strings.ToLower(name)); !ok || got != col {
			t.Errorf("ColumnIndex(%s) = %d, %v", name, got, ok)
		}
	}
	for _, bad := range []string{"", "A1", "ÄB", "AAAA"} {
		if _, ok := importsrc.ColumnIndex(bad); ok {
			t.Errorf("ColumnIndex(%q) ok", bad)
		}
	}
}

func TestDetect(t *testing.T) {
	xlsx := importsrctest.V1Workbook(t, nil)
	cases := []struct {
		name string
		data []byte
		kind importsrc.Kind
	}{
		{"Catalog.XLSX", xlsx, importsrc.KindXLSX},
		{"a.csv", []byte("a;b\n1;2\n"), importsrc.KindCSV},
		{"a.csv", []byte("\xef\xbb\xbfa,b\n"), importsrc.KindCSV},
		{"a.xls", []byte("\xd0\xcf\x11\xe0rest"), ""},    // legacy Excel: refused
		{"a.xlsx", []byte("a;b\n"), ""},                  // not a ZIP
		{"a.csv", xlsx, ""},                              // a workbook named .csv
		{"a.csv", []byte("a;b\x00\n"), ""},               // binary
		{"a.csv", []byte("Gr\xfc\xdfe;b\n"), ""},         // Latin-1, not UTF-8
		{"a.txt", []byte("a;b\n"), ""},                   // other extension
		{"a.png", importsrctest.PNG(t, color.White), ""}, // image
		{"noext", xlsx, ""},                              // no extension
	}
	for _, c := range cases {
		kind, err := importsrc.Detect(c.name, c.data)
		if c.kind == "" {
			if err == nil || code(t, err) != "import.file_type" {
				t.Errorf("%s: got %s, %v; want import.file_type", c.name, kind, err)
			}
			continue
		}
		if err != nil || kind != c.kind {
			t.Errorf("%s: got %s, %v", c.name, kind, err)
		}
	}
}

func TestXLSX(t *testing.T) {
	red, blue, green := importsrctest.PNG(t, color.RGBA{255, 0, 0, 255}), importsrctest.PNG(t, color.RGBA{0, 0, 255, 255}), importsrctest.PNG(t, color.RGBA{0, 255, 0, 255})
	data := importsrctest.V1Workbook(t, []importsrctest.V1Row{
		{Category: "Gateways", Name: "Gateway", Model: "GW-1", Style: "White", Price: 108, Images: [][]byte{red}},
		{Spacer: true},
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "Ivory White", Price: 27.499999999999996,
			Required: []string{"F-1  Ivory White"}, Optional: []string{"", "GW-1 White"},
			// A one-cell anchor first, then a two-cell anchor: the two-cell
			// anchor takes precedence.
			Images: [][]byte{green, blue}, OneCell: []bool{true, false}},
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "", Price: "007"},
	})
	src, err := importsrc.Open("catalog.xlsx", data, limits)
	if err != nil {
		t.Fatal(err)
	}
	if src.Kind() != importsrc.KindXLSX || !reflect.DeepEqual(src.Sheets(), []string{importsrctest.SheetName}) {
		t.Errorf("kind %s sheets %v", src.Kind(), src.Sheets())
	}
	table, err := src.Table("")
	if err != nil {
		t.Fatal(err)
	}
	numbers := []int{}
	for _, r := range table.Rows {
		numbers = append(numbers, r.Number)
	}
	// Row 5 holds only " " (blank) and is left out like rows 1-2.
	if !reflect.DeepEqual(numbers, []int{3, 4, 6, 7}) || table.Sheet != importsrctest.SheetName || table.Images != 3 {
		t.Fatalf("rows %v sheet %q images %d", numbers, table.Sheet, table.Images)
	}
	header := table.Rows[0]
	// Absolute columns: column A is empty, the header starts in B.
	if header.Cell(0) != "" || header.Cell(1) != "Category" || header.Cell(6) != "Model Number" || header.Cell(20) != "Optional Addon - 08" || header.Cell(99) != "" {
		t.Errorf("header %q", header.Cells)
	}
	gw, tile, standard := table.Rows[1], table.Rows[2], table.Rows[3]
	if gw.Cell(10) != "108" || gw.Cell(9) != "GW-1 White" {
		t.Errorf("gateway %q", gw.Cells)
	}
	// Floating-point noise is cleaned like the General format shows it;
	// text stays text.
	if tile.Cell(10) != "27.5" || standard.Cell(10) != "007" || standard.Cell(9) != "T-1 " {
		t.Errorf("price %q / %q, sku %q", tile.Cell(10), standard.Cell(10), standard.Cell(9))
	}
	if tile.Cell(12) != "F-1  Ivory White" || tile.Cell(16) != "" || tile.Cell(17) != "GW-1 White" {
		t.Errorf("add-ons %q", tile.Cells)
	}
	if len(gw.Images) != 1 || !bytes.Equal(gw.Images[0].Data, red) || gw.Images[0].Column != 3 || !gw.Images[0].TwoCell {
		t.Errorf("gateway image %+v", gw.Images)
	}
	if len(tile.Images) != 2 || !bytes.Equal(tile.Images[0].Data, blue) || !tile.Images[0].TwoCell ||
		!bytes.Equal(tile.Images[1].Data, green) || tile.Images[1].TwoCell {
		t.Errorf("tile images: two-cell anchor must come first: %+v", tile.Images)
	}
	if len(standard.Images) != 0 {
		t.Errorf("standard images %+v", standard.Images)
	}

	if _, err := src.Table("Other"); err == nil || code(t, err) != "import.sheet_not_found" {
		t.Errorf("unknown sheet: %v", err)
	}
	if tbl, err := src.Table(importsrctest.SheetName); err != nil || len(tbl.Rows) != 4 {
		t.Errorf("by name: %v", err)
	}
}

func TestXLSXLimits(t *testing.T) {
	img := importsrctest.PNG(t, color.White)
	rows := []importsrctest.V1Row{}
	for range 5 {
		rows = append(rows, importsrctest.V1Row{Category: "C", Name: "N", Model: "M", Style: "S", Price: 1, Images: [][]byte{img}})
	}
	data := importsrctest.V1Workbook(t, rows)
	open := func(l importsrc.Limits) error {
		src, err := importsrc.Open("a.xlsx", data, l)
		if err != nil {
			return err
		}
		_, err = src.Table("")
		return err
	}
	// 6 rows with content: the header and 5 rows.
	if err := open(importsrc.Limits{MaxRows: 5}); err == nil || code(t, err) != "import.too_many_rows" {
		t.Errorf("rows: %v", err)
	}
	if err := open(importsrc.Limits{MaxRows: 6, MaxImages: 4}); err == nil || code(t, err) != "import.too_many_images" {
		t.Errorf("images: %v", err)
	}
	if err := open(importsrc.Limits{MaxRows: 6, MaxImages: 5}); err != nil {
		t.Errorf("within limits: %v", err)
	}
	// Pictures above the byte limit come back marked, without data.
	src, _ := importsrc.Open("a.xlsx", data, importsrc.Limits{MaxImageBytes: 10})
	table, err := src.Table("")
	if err != nil || !table.Rows[1].Images[0].TooLarge || table.Rows[1].Images[0].Data != nil {
		t.Errorf("too large: %v %+v", err, table.Rows[1].Images)
	}
	// A damaged workbook.
	if _, err := importsrc.Open("a.xlsx", append([]byte("PK\x03\x04"), make([]byte, 100)...), limits); err == nil || code(t, err) != "import.unreadable" {
		t.Errorf("damaged: %v", err)
	}
}

// A workbook whose used range starts in column A: columns are absolute, so
// nothing shifts.
func TestXLSXColumnA(t *testing.T) {
	f := excelize.NewFile()
	_ = f.SetCellValue("Sheet1", "A1", "Model")
	_ = f.SetCellValue("Sheet1", "C1", "Price")
	_ = f.SetCellValue("Sheet1", "A2", "M-1")
	_ = f.SetCellValue("Sheet1", "C2", 2.5)
	var buf bytes.Buffer
	_ = f.Write(&buf)
	src, err := importsrc.Open("a.xlsx", buf.Bytes(), limits)
	if err != nil {
		t.Fatal(err)
	}
	table, err := src.Table("")
	if err != nil || len(table.Rows) != 2 || table.Rows[1].Cell(0) != "M-1" || table.Rows[1].Cell(2) != "2.5" {
		t.Fatalf("%v %+v", err, table)
	}
}

func TestCSV(t *testing.T) {
	cases := []struct {
		name string
		data string
		rows map[int][]string
	}{
		{"semicolon with BOM", "\xef\xbb\xbfModel;Price;Name\nM-1;2,5;\"Tile; white\"\n", map[int][]string{
			1: {"Model", "Price", "Name"}, 2: {"M-1", "2,5", "Tile; white"},
		}},
		{"comma", "Model,Price\r\nM-1,\"1,234.5\"\r\n", map[int][]string{1: {"Model", "Price"}, 2: {"M-1", "1,234.5"}}},
		{"quoted delimiters do not count", "\"a,b,c\";d\n1;2\n", map[int][]string{1: {"a,b,c", "d"}, 2: {"1", "2"}}},
		{"quotes, line breaks and blank lines", "Model;Desc\n\nM-1;\"two\nlines \"\"quoted\"\"\"\n ; \nM-2;x\n", map[int][]string{
			1: {"Model", "Desc"}, 3: {"M-1", "two\nlines \"quoted\""}, 6: {"M-2", "x"},
		}},
	}
	for _, c := range cases {
		src, err := importsrc.Open("a.csv", []byte(c.data), limits)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		table, err := src.Table("")
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		got := map[int][]string{}
		for _, r := range table.Rows {
			got[r.Number] = r.Cells
		}
		if !reflect.DeepEqual(got, c.rows) {
			t.Errorf("%s: %v", c.name, got)
		}
		if src.Kind() != importsrc.KindCSV || !reflect.DeepEqual(src.Sheets(), []string{""}) {
			t.Errorf("%s: kind %s sheets %q", c.name, src.Kind(), src.Sheets())
		}
	}
	src, _ := importsrc.Open("a.csv", []byte("a\n"), limits)
	if _, err := src.Table("Sheet1"); err == nil || code(t, err) != "import.sheet_not_found" {
		t.Errorf("sheet: %v", err)
	}
	if _, err := importsrc.Open("a.csv", []byte("a\nb\nc\n"), importsrc.Limits{MaxRows: 2}); err == nil || code(t, err) != "import.too_many_rows" {
		t.Errorf("rows: %v", err)
	}
	if _, err := importsrc.Open("a.csv", []byte("a;\"b\nc"), limits); err != nil {
		// An unterminated quote is read leniently up to the end.
		t.Errorf("lazy quotes: %v", err)
	}
}

// The real SnapFlow 1 workbook (9.3 MB, not in the repository): set
// SNAPFLOW_V1_WORKBOOK to its path to run this test.
func TestRealWorkbook(t *testing.T) {
	p := os.Getenv("SNAPFLOW_V1_WORKBOOK")
	if p == "" {
		t.Skip("SNAPFLOW_V1_WORKBOOK not set")
	}
	data, err := os.ReadFile(p) //nolint:gosec // a test input chosen by the developer
	if err != nil {
		t.Fatal(err)
	}
	src, err := importsrc.Open(p, data, importsrc.Limits{MaxRows: 20000, MaxImages: 5000, MaxImageBytes: 10 << 20})
	if err != nil {
		t.Fatal(err)
	}
	table, err := src.Table("")
	if err != nil {
		t.Fatal(err)
	}
	withImage, media := 0, map[string]bool{}
	for _, r := range table.Rows {
		if len(r.Images) > 0 {
			withImage++
		}
		for _, img := range r.Images {
			media[img.Name] = true
		}
	}
	if table.Rows[0].Number != 3 || table.Rows[0].Cell(1) != "Category" || withImage != 201 || len(media) != 77 {
		t.Errorf("first row %d %q, rows with pictures %d, media %d", table.Rows[0].Number, table.Rows[0].Cell(1), withImage, len(media))
	}
}
