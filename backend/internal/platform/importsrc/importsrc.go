// Package importsrc reads import files into tables: sheets of rows of text
// cells, with the pictures anchored to each row. It is the extension point
// for import sources (D119): an adapter turns its format into a Table; the
// import pipeline (features/imports) maps the table to the catalog. XLSX
// and CSV exist; supplier APIs or JSON feeds would be further adapters.
//
// Cells are addressed by their absolute column (0 = column A), whatever the
// sheet's used range, so a column typed into an empty column A shifts
// nothing (SnapFlow 1 read columns relative to the used range).
package importsrc

import (
	"bytes"
	"net/http"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// Kind is a source format.
type Kind string

const (
	KindXLSX Kind = "xlsx"
	KindCSV  Kind = "csv"
)

// Limits bound what a source reads.
type Limits struct {
	// MaxRows is the most rows with content a sheet may have.
	MaxRows int
	// MaxImages is the most pictures a sheet may anchor.
	MaxImages int
	// MaxImageBytes is the largest picture read; larger ones come back
	// with TooLarge set and no data.
	MaxImageBytes int
}

// Source is an opened import file.
type Source interface {
	Kind() Kind
	// Sheets lists the sheet names in workbook order (one unnamed sheet
	// for CSV).
	Sheets() []string
	// Table reads a sheet; "" is the first sheet.
	Table(sheet string) (*Table, error)
}

// Table is one sheet.
type Table struct {
	Sheet string
	// Rows are in sheet order with their sheet row numbers; rows without
	// cells or pictures are left out.
	Rows []Row
	// Images is the number of pictures anchored to rows.
	Images int
}

// Row is one sheet row.
type Row struct {
	// Number is the row number as the spreadsheet shows it (1 first).
	Number int
	// Cells are the cell texts by absolute column (0 = A); trailing empty
	// cells may be missing.
	Cells []string
	// Images are the pictures anchored to the row, in precedence order:
	// two-cell anchors before one-cell anchors, then document order.
	Images []Image
}

// Cell returns the text in column col ("" if there is none).
func (r Row) Cell(col int) string {
	if col < 0 || col >= len(r.Cells) {
		return ""
	}
	return r.Cells[col]
}

// Blank reports whether the row has no text (white space only) and no
// pictures.
func (r Row) Blank() bool {
	if len(r.Images) > 0 {
		return false
	}
	for _, c := range r.Cells {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// Image is a picture anchored to a row.
type Image struct {
	// Name is the picture's part in the file, e.g. "xl/media/image3.png";
	// pictures with the same name have the same bytes.
	Name string
	// Column is the anchor's column (0 = A).
	Column int
	// TwoCell is true for a two-cell anchor (moves and sizes with cells).
	TwoCell bool
	Data    []byte
	// TooLarge is set instead of Data for pictures above
	// Limits.MaxImageBytes.
	TooLarge bool
}

// Open detects the format by extension and content and opens the file.
func Open(name string, data []byte, limits Limits) (Source, error) {
	kind, err := Detect(name, data)
	if err != nil {
		return nil, err
	}
	if kind == KindCSV {
		return openCSV(data, limits)
	}
	return openXLSX(data, limits)
}

// Detect returns the format of a file by its extension and content: an
// .xlsx must be a ZIP archive, a .csv must be UTF-8 text. Anything else
// (also .xls) is 415 import.file_type.
func Detect(name string, data []byte) (Kind, error) {
	switch strings.ToLower(path.Ext(name)) {
	case ".xlsx":
		if bytes.HasPrefix(data, []byte("PK\x03\x04")) {
			return KindXLSX, nil
		}
	case ".csv":
		if !bytes.HasPrefix(data, []byte("PK\x03\x04")) && bytes.IndexByte(data, 0) < 0 && utf8.Valid(data) {
			return KindCSV, nil
		}
	}
	return "", ErrFileType()
}

// ErrFileType reports a file that is not XLSX or CSV.
func ErrFileType() *apperr.Error {
	return apperr.New(http.StatusUnsupportedMediaType, "import.file_type", "only .xlsx and UTF-8 .csv files can be imported")
}

// ErrUnreadable reports a file that claims a supported format but cannot be
// read (a damaged workbook, say).
func ErrUnreadable() *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, "import.unreadable", "the file cannot be read")
}

func errTooManyRows(max int) *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, "import.too_many_rows", "the sheet has too many rows").With("max", max)
}

func errTooManyImages(max int) *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, "import.too_many_images", "the sheet has too many pictures").With("max", max)
}

// ErrSheetNotFound reports a sheet name the file does not have.
func ErrSheetNotFound(sheet string) *apperr.Error {
	return apperr.New(http.StatusUnprocessableEntity, "import.sheet_not_found", "the file has no such sheet").With("sheet", sheet)
}

// ColumnName returns the letters of a column (0 = "A", 26 = "AA").
func ColumnName(col int) string {
	name := ""
	for col++; col > 0; col = (col - 1) / 26 {
		name = string(rune('A'+(col-1)%26)) + name
	}
	return name
}

// ColumnIndex returns the column of letters ("A" = 0, case-insensitive);
// ok is false for anything but 1-3 letters.
func ColumnIndex(letters string) (col int, ok bool) {
	letters = strings.ToUpper(strings.TrimSpace(letters))
	if letters == "" || len(letters) > 3 {
		return 0, false
	}
	for _, r := range letters {
		if r < 'A' || r > 'Z' {
			return 0, false
		}
		col = col*26 + int(r-'A'+1)
	}
	return col - 1, true
}
