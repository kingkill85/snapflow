// Package importsrctest builds import files for tests: a workbook in the
// layout of SnapFlow 1's catalog workbook (header row 3, data from row 4,
// columns B-U, pictures floating over the rows), generated at test time so
// no binary fixture is needed.
package importsrctest

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"

	"github.com/xuri/excelize/v2"
)

// V1Header is SnapFlow 1's header row, columns B to U (L and P are empty
// separators).
var V1Header = []string{
	"Category", "#", "Item Photo", "Item Name", "Item Description", "Model Number", "Dimensions (mm)", "Style",
	"Model Number + Style", "Price (USD)", "",
	"Mandatory Addon - 01", "Mandatory Addon - 02", "Mandatory Addon - 03", "",
	"Optional Addon - 04", "Optional Addon - 05", "Optional Addon - 06", "Optional Addon - 07", "Optional Addon - 08",
}

// V1Row is one row of a SnapFlow 1 workbook.
type V1Row struct {
	// Spacer writes a row whose only content is " " in column J, as the
	// real workbook's blank separator rows have.
	Spacer      bool
	Category    string
	Name        string
	Description string
	Model       string
	Dimensions  string
	Style       string
	// SKU is column J ("Model Number + Style"); empty means Model + " " +
	// Style (with a trailing space when the style is empty, like the real
	// file).
	SKU string
	// Price is written as a number when it parses as one, else as text.
	Price    any
	Required []string // M-O
	Optional []string // Q-U
	// Images are PNG or JPEG pictures floating over the row (column D),
	// added in order; OneCell anchors them with a one-cell anchor.
	Images  [][]byte
	OneCell []bool
}

// SheetName is the sheet the workbook's rows are on.
const SheetName = "SnapFlow Assets 2.0a"

// V1Workbook returns an .xlsx in SnapFlow 1's layout: rows 1-2 empty, the
// header in row 3 (B-U), rows from row 4.
func V1Workbook(t testing.TB, rows []V1Row) []byte {
	t.Helper()
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	if err := f.SetSheetName("Sheet1", SheetName); err != nil {
		t.Fatal(err)
	}
	set := func(col, row int, v any) {
		cell, err := excelize.CoordinatesToCellName(col, row)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.SetCellValue(SheetName, cell, v); err != nil {
			t.Fatal(err)
		}
	}
	for i, h := range V1Header {
		if h != "" {
			set(2+i, 3, h)
		}
	}
	for i, r := range rows {
		n := 4 + i
		if r.Spacer {
			set(10, n, " ")
			continue
		}
		sku := r.SKU
		if sku == "" {
			sku = r.Model + " " + r.Style
		}
		for col, v := range map[int]string{2: r.Category, 5: r.Name, 6: r.Description, 7: r.Model, 8: r.Dimensions, 9: r.Style, 10: sku} {
			if v != "" {
				set(col, n, v)
			}
		}
		if r.Price != nil {
			set(11, n, r.Price)
		}
		for j, ref := range r.Required {
			set(13+j, n, ref)
		}
		for j, ref := range r.Optional {
			set(17+j, n, ref)
		}
		for j, img := range r.Images {
			cell, _ := excelize.CoordinatesToCellName(4, n)
			opts := &excelize.GraphicOptions{Positioning: "twoCell"}
			if j < len(r.OneCell) && r.OneCell[j] {
				opts.Positioning = "oneCell"
			}
			if err := f.AddPictureFromBytes(SheetName, cell, &excelize.Picture{Extension: ext(img), File: img, Format: opts}); err != nil {
				t.Fatal(err)
			}
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func ext(img []byte) string {
	if bytes.HasPrefix(img, []byte{0xff, 0xd8}) {
		return ".jpg"
	}
	return ".png"
}

// PNG returns a small PNG of one colour.
func PNG(t testing.TB, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for x := range 4 {
		for y := range 3 {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
