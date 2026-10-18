package importsrc

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

// Unpacking limits: a 50 MB upload may not expand without bound (zip bomb).
const (
	maxUnzipped    = 512 << 20
	maxUnzippedXML = 64 << 20
	maxDrawingXML  = 32 << 20
)

// xlsxSource is an Office Open XML workbook. Cells are read with excelize;
// pictures come from the sheet's drawing part (xl/drawings/drawingN.xml):
// every picture anchored by a two-cell or one-cell anchor belongs to the
// anchor's start row (SnapFlow 1 behaviour, inventory 01 G111).
type xlsxSource struct {
	data   []byte
	file   *excelize.File
	limits Limits
}

func openXLSX(data []byte, limits Limits) (Source, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data), excelize.Options{
		UnzipSizeLimit: maxUnzipped, UnzipXMLSizeLimit: maxUnzippedXML,
	})
	if err != nil {
		return nil, ErrUnreadable()
	}
	return &xlsxSource{data: data, file: f, limits: limits}, nil
}

func (s *xlsxSource) Kind() Kind       { return KindXLSX }
func (s *xlsxSource) Sheets() []string { return s.file.GetSheetList() }

func (s *xlsxSource) Table(sheet string) (*Table, error) {
	sheets := s.Sheets()
	if len(sheets) == 0 {
		return nil, ErrUnreadable()
	}
	if strings.TrimSpace(sheet) == "" {
		sheet = sheets[0]
	}
	found := false
	for _, name := range sheets {
		if name == sheet {
			found = true
		}
	}
	if !found {
		return nil, ErrSheetNotFound(sheet)
	}

	images, err := s.images(sheet)
	if err != nil {
		return nil, err
	}

	rows, err := s.file.Rows(sheet)
	if err != nil {
		return nil, ErrUnreadable()
	}
	defer func() { _ = rows.Close() }()
	t := &Table{Sheet: sheet}
	content := 0
	for number := 1; rows.Next(); number++ {
		cells, err := rows.Columns(excelize.Options{RawCellValue: true})
		if err != nil {
			return nil, ErrUnreadable()
		}
		for col, c := range cells {
			cells[col] = s.cleanNumber(sheet, col, number, c)
		}
		row := Row{Number: number, Cells: cells, Images: images[number]}
		if row.Blank() {
			continue
		}
		if content++; s.limits.MaxRows > 0 && content > s.limits.MaxRows {
			return nil, errTooManyRows(s.limits.MaxRows)
		}
		t.Images += len(row.Images)
		t.Rows = append(t.Rows, row)
	}
	if rows.Error() != nil {
		return nil, ErrUnreadable()
	}
	// Pictures anchored below the last row with cells.
	last := 0
	if len(t.Rows) > 0 {
		last = t.Rows[len(t.Rows)-1].Number
	}
	for number, list := range images {
		if number > last {
			t.Rows = append(t.Rows, Row{Number: number, Images: list})
			t.Images += len(list)
		}
	}
	sortRows(t.Rows)
	return t, nil
}

// cleanNumber turns a numeric cell's stored value into what the
// spreadsheet shows with the General format: at most 15 significant digits
// (27.499999999999996 is 27.5), no exponent. Text cells stay as they are.
func (s *xlsxSource) cleanNumber(sheet string, col, row int, raw string) string {
	if !strings.ContainsAny(raw, ".eE") {
		return raw
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return raw
	}
	cell, err := excelize.CoordinatesToCellName(col+1, row)
	if err != nil {
		return raw
	}
	if t, err := s.file.GetCellType(sheet, cell); err != nil || (t != excelize.CellTypeNumber && t != excelize.CellTypeUnset) {
		return raw
	}
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(f, 'g', 15, 64), 64)
	if err != nil {
		return raw
	}
	return strconv.FormatFloat(rounded, 'f', -1, 64)
}

// ---------------------------------------------------------------- pictures

type relationships struct {
	Items []struct {
		ID     string `xml:"Id,attr"`
		Type   string `xml:"Type,attr"`
		Target string `xml:"Target,attr"`
	} `xml:"Relationship"`
}

type workbookXML struct {
	Sheets []struct {
		Name string `xml:"name,attr"`
		RID  string `xml:"http://schemas.openxmlformats.org/officeDocument/2006/relationships id,attr"`
	} `xml:"sheets>sheet"`
}

type anchorXML struct {
	From struct {
		Col int `xml:"col"`
		Row int `xml:"row"`
	} `xml:"from"`
	Pics []struct {
		Blip struct {
			Embed string `xml:"embed,attr"`
		} `xml:"blipFill>blip"`
	} `xml:"pic"`
}

type anchorsXML struct {
	TwoCell []anchorXML `xml:"twoCellAnchor"`
	OneCell []anchorXML `xml:"oneCellAnchor"`
}

type drawingXML struct {
	anchorsXML
	// Excel may wrap anchors in markup-compatibility blocks.
	Alternate []struct {
		Choice anchorsXML `xml:"Choice"`
	} `xml:"AlternateContent"`
}

// images returns the pictures of a sheet by row number, in precedence
// order per row: two-cell anchors first (SnapFlow 1 preferred them), then
// one-cell anchors, each in document order. Absolute anchors have no row
// and are ignored. A sheet without a drawing has no pictures.
func (s *xlsxSource) images(sheet string) (map[int][]Image, error) {
	zr, err := zip.NewReader(bytes.NewReader(s.data), int64(len(s.data)))
	if err != nil {
		return nil, ErrUnreadable()
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[strings.TrimPrefix(f.Name, "/")] = f
	}
	var wb workbookXML
	if err := readXML(files, "xl/workbook.xml", &wb); err != nil {
		return nil, err
	}
	var wbRels relationships
	if err := readXML(files, "xl/_rels/workbook.xml.rels", &wbRels); err != nil {
		return nil, err
	}
	sheetPart := ""
	for _, sh := range wb.Sheets {
		if sh.Name == sheet {
			sheetPart = target(wbRels, sh.RID, "xl")
		}
	}
	if sheetPart == "" {
		return map[int][]Image{}, nil
	}
	var sheetRels relationships
	relsPart := path.Join(path.Dir(sheetPart), "_rels", path.Base(sheetPart)+".rels")
	if _, ok := files[relsPart]; !ok {
		return map[int][]Image{}, nil
	}
	if err := readXML(files, relsPart, &sheetRels); err != nil {
		return nil, err
	}
	out := map[int][]Image{}
	count := 0
	for _, rel := range sheetRels.Items {
		if !strings.HasSuffix(rel.Type, "/drawing") {
			continue
		}
		drawingPart := resolve(path.Dir(sheetPart), rel.Target)
		var drawing drawingXML
		if err := readXML(files, drawingPart, &drawing); err != nil {
			return nil, err
		}
		var drawingRels relationships
		drawingRelsPart := path.Join(path.Dir(drawingPart), "_rels", path.Base(drawingPart)+".rels")
		if _, ok := files[drawingRelsPart]; ok {
			if err := readXML(files, drawingRelsPart, &drawingRels); err != nil {
				return nil, err
			}
		}
		two, one := drawing.TwoCell, drawing.OneCell
		for _, alt := range drawing.Alternate {
			two = append(two, alt.Choice.TwoCell...)
			one = append(one, alt.Choice.OneCell...)
		}
		// Two-cell anchors first: per row they take precedence.
		for i, a := range append(append([]anchorXML{}, two...), one...) {
			for _, pic := range a.Pics {
				media := target(drawingRels, pic.Blip.Embed, path.Dir(drawingPart))
				if media == "" {
					continue
				}
				if count++; s.limits.MaxImages > 0 && count > s.limits.MaxImages {
					return nil, errTooManyImages(s.limits.MaxImages)
				}
				img := Image{Name: media, Column: a.From.Col, TwoCell: i < len(two)}
				img.Data, img.TooLarge, err = readPart(files, media, s.limits.MaxImageBytes)
				if err != nil {
					return nil, err
				}
				row := a.From.Row + 1
				out[row] = append(out[row], img)
			}
		}
	}
	return out, nil
}

// target resolves a relationship id to a part name ("" if unknown).
func target(rels relationships, id, base string) string {
	for _, r := range rels.Items {
		if r.ID == id {
			return resolve(base, r.Target)
		}
	}
	return ""
}

// resolve turns a relationship target into a part name: absolute targets
// start at the package root, relative ones at base.
func resolve(base, t string) string {
	if strings.HasPrefix(t, "/") {
		return path.Clean(strings.TrimPrefix(t, "/"))
	}
	return path.Clean(path.Join(base, t))
}

func readXML(files map[string]*zip.File, name string, v any) error {
	data, tooLarge, err := readPart(files, name, maxDrawingXML)
	if err != nil {
		return err
	}
	if tooLarge || xml.Unmarshal(data, v) != nil {
		return ErrUnreadable()
	}
	return nil
}

// readPart reads a part of at most max bytes (tooLarge beyond that).
func readPart(files map[string]*zip.File, name string, max int) (data []byte, tooLarge bool, err error) {
	f, ok := files[name]
	if !ok {
		return nil, false, ErrUnreadable()
	}
	rc, err := f.Open()
	if err != nil {
		return nil, false, ErrUnreadable()
	}
	defer func() { _ = rc.Close() }()
	var r io.Reader = rc
	if max > 0 {
		r = io.LimitReader(rc, int64(max)+1)
	}
	data, err = io.ReadAll(r)
	if err != nil {
		return nil, false, ErrUnreadable()
	}
	if max > 0 && len(data) > max {
		return nil, true, nil
	}
	return data, false, nil
}

func sortRows(rows []Row) {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Number < rows[j].Number })
}
