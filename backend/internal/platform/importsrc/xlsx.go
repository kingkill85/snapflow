package importsrc

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"math"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Unpacking limits: a 50 MB upload may not expand without bound (zip bomb).
// The worksheet is streamed (its rows are bounded by Limits), so only the
// parts held in memory have a tighter cap.
const (
	maxUnzipped    = 512 << 20
	maxUnzippedXML = 64 << 20
	maxDrawingXML  = 32 << 20
)

// xlsxSource is an Office Open XML workbook, read straight from the ZIP
// archive (nothing is unpacked to disk): the worksheet is streamed row by row
// with encoding/xml, shared strings are read once, and pictures come from the
// sheet's drawing part (xl/drawings/drawingN.xml): every picture anchored by a
// two-cell or one-cell anchor belongs to the anchor's start row (SnapFlow 1
// behaviour, inventory 01 G111). Picture bytes are read only by ImageData.
type xlsxSource struct {
	files   map[string]*zip.File
	sheets  []sheetRef
	sstPart string
	limits  Limits

	sstOnce sync.Once
	sst     []string
	sstErr  error
}

type sheetRef struct {
	name, part string
}

func openXLSX(data []byte, limits Limits) (Source, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, ErrUnreadable()
	}
	s := &xlsxSource{files: map[string]*zip.File{}, limits: limits}
	var total uint64
	for _, f := range zr.File {
		s.files[strings.TrimPrefix(f.Name, "/")] = f
		total += f.UncompressedSize64
	}
	if total > maxUnzipped {
		return nil, ErrUnreadable()
	}
	workbookPart := "xl/workbook.xml"
	if _, ok := s.files["_rels/.rels"]; ok {
		var rootRels relationships
		if err := readXML(s.files, "_rels/.rels", &rootRels); err != nil {
			return nil, err
		}
		for _, r := range rootRels.Items {
			if strings.HasSuffix(r.Type, "/officeDocument") {
				workbookPart = resolve("", r.Target)
			}
		}
	}
	var wb workbookXML
	if err := readXML(s.files, workbookPart, &wb); err != nil {
		return nil, err
	}
	var wbRels relationships
	relsPart := relsOf(workbookPart)
	if err := readXML(s.files, relsPart, &wbRels); err != nil {
		return nil, err
	}
	for _, sh := range wb.Sheets {
		s.sheets = append(s.sheets, sheetRef{name: sh.Name, part: target(wbRels, sh.RID, path.Dir(workbookPart))})
	}
	for _, r := range wbRels.Items {
		if strings.HasSuffix(r.Type, "/sharedStrings") {
			s.sstPart = resolve(path.Dir(workbookPart), r.Target)
		}
	}
	return s, nil
}

func (s *xlsxSource) Kind() Kind { return KindXLSX }
func (s *xlsxSource) Close() error {
	s.sst = nil
	return nil
}

func (s *xlsxSource) Sheets() []string {
	out := make([]string, len(s.sheets))
	for i, sh := range s.sheets {
		out[i] = sh.name
	}
	return out
}

func (s *xlsxSource) Table(sheet string) (*Table, error) {
	if len(s.sheets) == 0 {
		return nil, ErrUnreadable()
	}
	ref := s.sheets[0]
	if strings.TrimSpace(sheet) != "" {
		found := false
		for _, sh := range s.sheets {
			if sh.name == sheet {
				ref, found = sh, true
			}
		}
		if !found {
			return nil, ErrSheetNotFound(sheet)
		}
	}
	if _, ok := s.files[ref.part]; !ok {
		return nil, ErrUnreadable()
	}
	images, err := s.images(ref.part)
	if err != nil {
		return nil, err
	}
	t := &Table{Sheet: ref.name}
	content := 0
	err = s.rows(ref.part, func(number int, cells []string) error {
		row := Row{Number: number, Cells: cells, Images: images[number]}
		if row.Blank() {
			return nil
		}
		if content++; s.limits.MaxRows > 0 && content > s.limits.MaxRows {
			return errTooManyRows(s.limits.MaxRows)
		}
		t.Images += len(row.Images)
		t.Rows = append(t.Rows, row)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Pictures anchored to rows without cells.
	seen := make(map[int]bool, len(t.Rows))
	for _, r := range t.Rows {
		seen[r.Number] = true
	}
	for number, list := range images {
		if !seen[number] {
			t.Rows = append(t.Rows, Row{Number: number, Images: list})
			t.Images += len(list)
		}
	}
	sortRows(t.Rows)
	return t, nil
}

// ImageData reads a picture part, at most Limits.MaxImageBytes.
func (s *xlsxSource) ImageData(name string) ([]byte, error) {
	data, tooLarge, err := readPart(s.files, name, s.limits.MaxImageBytes)
	if err != nil {
		return nil, err
	}
	if tooLarge {
		return nil, ErrImageTooLarge(s.limits.MaxImageBytes)
	}
	return data, nil
}

// ---------------------------------------------------------------- cells

// rows streams the worksheet part and calls fn for each row element with
// its number (the r attribute, else the previous row's plus one) and its
// cell texts by absolute column (trailing empty cells left out). Values are
// what the cell stores, like excelize's RawCellValue: shared and inline
// strings, booleans as 1/0, formula results as cached; numbers are cleaned
// to what the General format shows (cleanNumber). A cell with a value
// beyond Limits.MaxColumns is import.too_many_columns.
func (s *xlsxSource) rows(part string, fn func(number int, cells []string) error) error {
	rc, err := s.files[part].Open()
	if err != nil {
		return ErrUnreadable()
	}
	defer func() { _ = rc.Close() }()
	dec := xml.NewDecoder(io.LimitReader(rc, maxUnzipped))
	var (
		number int
		cells  []string
		inRow  bool
		last   int // the previous cell's column
	)
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			if inRow {
				return ErrUnreadable()
			}
			return nil
		}
		if err != nil {
			return ErrUnreadable()
		}
		switch el := tok.(type) {
		case xml.StartElement:
			switch el.Name.Local {
			case "row":
				if r := attr(el, "r"); r != "" {
					n, err := strconv.Atoi(r)
					if err != nil || n < 1 {
						return ErrUnreadable()
					}
					number = n
				} else {
					number++
				}
				cells, inRow, last = nil, true, -1
			case "c":
				if !inRow {
					return ErrUnreadable()
				}
				col, value, err := s.cell(dec, el, last+1)
				if err != nil {
					return err
				}
				last = col
				if value == "" {
					continue
				}
				if s.limits.MaxColumns > 0 && col >= s.limits.MaxColumns {
					return errTooManyColumns(s.limits.MaxColumns)
				}
				for len(cells) < col {
					cells = append(cells, "")
				}
				if col < len(cells) {
					cells[col] = value
				} else {
					cells = append(cells, value)
				}
			}
		case xml.EndElement:
			switch el.Name.Local {
			case "row":
				if inRow {
					inRow = false
					if err := fn(number, cells); err != nil {
						return err
					}
				}
			case "sheetData":
				return nil
			}
		}
	}
}

// cell reads one c element (the decoder is past its start) and returns its
// column (from the r attribute, else next, the column after the previous
// cell) and value.
func (s *xlsxSource) cell(dec *xml.Decoder, start xml.StartElement, next int) (int, string, error) {
	col := next
	if r := attr(start, "r"); r != "" {
		c, ok := cellColumn(r)
		if !ok {
			return 0, "", ErrUnreadable()
		}
		col = c
	}
	typ := attr(start, "t")
	var v, inline strings.Builder
	hasInline := false
	depth, in := 0, ""
	phonetic := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return 0, "", ErrUnreadable()
		}
		switch el := tok.(type) {
		case xml.StartElement:
			depth++
			switch {
			case depth == 1:
				in = el.Name.Local
				hasInline = hasInline || in == "is"
			case in == "is" && el.Name.Local == "rPh":
				phonetic++
			}
			if in == "is" && el.Name.Local == "t" && phonetic == 0 {
				if err := appendText(dec, &inline); err != nil {
					return 0, "", err
				}
				depth--
			}
		case xml.CharData:
			if depth == 1 && in == "v" {
				v.Write(el)
			}
		case xml.EndElement:
			if depth == 0 {
				value, err := s.value(typ, v.String(), inline.String(), hasInline)
				return col, value, err
			}
			if in == "is" && el.Name.Local == "rPh" {
				phonetic--
			}
			depth--
		}
	}
}

// appendText adds the text of the element the decoder is in (a t element)
// to b and consumes its end.
func appendText(dec *xml.Decoder, b *strings.Builder) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return ErrUnreadable()
		}
		switch el := tok.(type) {
		case xml.CharData:
			b.Write(el)
		case xml.EndElement:
			return nil
		case xml.StartElement:
			if err := dec.Skip(); err != nil {
				return ErrUnreadable()
			}
		}
	}
}

// value turns a cell's stored value into its text by its type (t).
func (s *xlsxSource) value(typ, v, inline string, hasInline bool) (string, error) {
	switch typ {
	case "s":
		if strings.TrimSpace(v) == "" {
			return "", nil
		}
		i, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return "", ErrUnreadable()
		}
		sst, err := s.sharedStrings()
		if err != nil {
			return "", err
		}
		if i < 0 || i >= len(sst) {
			return "", ErrUnreadable()
		}
		return sst[i], nil
	case "inlineStr":
		if hasInline {
			return unescapeText(inline), nil
		}
		return v, nil
	case "", "n":
		return cleanNumber(v), nil
	}
	// str (a formula's text), b (1/0), d (ISO date), e (#N/A, ...).
	return v, nil
}

// cleanNumber turns a numeric cell's stored value into what the
// spreadsheet shows with the General format: at most 15 significant digits
// (27.499999999999996 is 27.5), no exponent.
func cleanNumber(raw string) string {
	if !strings.ContainsAny(raw, ".eE") {
		return raw
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return raw
	}
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(f, 'g', 15, 64), 64)
	if err != nil {
		return raw
	}
	return strconv.FormatFloat(rounded, 'f', -1, 64)
}

// sharedStrings reads the workbook's shared strings once: each si element's
// text (its t, or its runs' t, without phonetic runs).
func (s *xlsxSource) sharedStrings() ([]string, error) {
	s.sstOnce.Do(func() {
		if s.sstPart == "" {
			return
		}
		f, ok := s.files[s.sstPart]
		if !ok || f.UncompressedSize64 > maxUnzippedXML {
			s.sstErr = ErrUnreadable()
			return
		}
		rc, err := f.Open()
		if err != nil {
			s.sstErr = ErrUnreadable()
			return
		}
		defer func() { _ = rc.Close() }()
		dec := xml.NewDecoder(io.LimitReader(rc, maxUnzippedXML))
		var (
			text     strings.Builder
			inSI     bool
			phonetic int
		)
		for {
			tok, err := dec.Token()
			if errors.Is(err, io.EOF) {
				return
			}
			if err != nil {
				s.sstErr = ErrUnreadable()
				return
			}
			switch el := tok.(type) {
			case xml.StartElement:
				switch el.Name.Local {
				case "si":
					inSI = true
					text.Reset()
				case "rPh":
					phonetic++
				case "t":
					if inSI && phonetic == 0 {
						if err := appendText(dec, &text); err != nil {
							s.sstErr = err
							return
						}
					}
				}
			case xml.EndElement:
				switch el.Name.Local {
				case "si":
					inSI = false
					s.sst = append(s.sst, unescapeText(text.String()))
				case "rPh":
					phonetic--
				}
			}
		}
	})
	return s.sst, s.sstErr
}

// escapePattern is an escaped character in OOXML text (ST_Xstring), e.g.
// _x000D_ for a carriage return; _x005F_ escapes the underscore.
var escapePattern = regexp.MustCompile(`_x[0-9A-Fa-f]{4}_`)

func unescapeText(s string) string {
	if !strings.Contains(s, "_x") {
		return s
	}
	return escapePattern.ReplaceAllStringFunc(s, func(m string) string {
		n, err := strconv.ParseUint(m[2:6], 16, 32)
		if err != nil {
			return m
		}
		return string(rune(n))
	})
}

// cellColumn returns the column of a cell reference such as "AB12".
func cellColumn(ref string) (int, bool) {
	i := 0
	for i < len(ref) && (ref[i] >= 'A' && ref[i] <= 'Z' || ref[i] >= 'a' && ref[i] <= 'z') {
		i++
	}
	if i == 0 || i > 3 {
		return 0, false
	}
	return ColumnIndex(ref[:i])
}

func attr(el xml.StartElement, name string) string {
	for _, a := range el.Attr {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
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
// and are ignored. A sheet without a drawing has no pictures. No picture is
// read: their size comes from the archive (which archive/zip enforces), and
// the distinct pictures together may hold at most Limits.MaxImageTotal
// bytes (import.images_too_large).
func (s *xlsxSource) images(sheetPart string) (map[int][]Image, error) {
	relsPart := relsOf(sheetPart)
	if _, ok := s.files[relsPart]; !ok {
		return map[int][]Image{}, nil
	}
	var sheetRels relationships
	if err := readXML(s.files, relsPart, &sheetRels); err != nil {
		return nil, err
	}
	out := map[int][]Image{}
	count := 0
	sizes := map[string]uint64{}
	for _, rel := range sheetRels.Items {
		if !strings.HasSuffix(rel.Type, "/drawing") {
			continue
		}
		drawingPart := resolve(path.Dir(sheetPart), rel.Target)
		var drawing drawingXML
		if err := readXML(s.files, drawingPart, &drawing); err != nil {
			return nil, err
		}
		var drawingRels relationships
		if _, ok := s.files[relsOf(drawingPart)]; ok {
			if err := readXML(s.files, relsOf(drawingPart), &drawingRels); err != nil {
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
				f, ok := s.files[media]
				if !ok {
					return nil, ErrUnreadable()
				}
				if count++; s.limits.MaxImages > 0 && count > s.limits.MaxImages {
					return nil, errTooManyImages(s.limits.MaxImages)
				}
				img := Image{Name: media, Column: a.From.Col, TwoCell: i < len(two), Size: int64(f.UncompressedSize64)} //nolint:gosec // bounded by maxUnzipped
				img.TooLarge = s.limits.MaxImageBytes > 0 && f.UncompressedSize64 > uint64(s.limits.MaxImageBytes)
				if !img.TooLarge {
					sizes[media] = f.UncompressedSize64
				}
				row := a.From.Row + 1
				out[row] = append(out[row], img)
			}
		}
	}
	var total uint64
	for _, size := range sizes {
		total += size
	}
	if s.limits.MaxImageTotal > 0 && total > uint64(s.limits.MaxImageTotal) {
		return nil, errImagesTooLarge(s.limits.MaxImageTotal)
	}
	return out, nil
}

// relsOf is the relationships part of a part.
func relsOf(part string) string {
	return path.Join(path.Dir(part), "_rels", path.Base(part)+".rels")
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
	if max > 0 && f.UncompressedSize64 > uint64(max) {
		return nil, true, nil
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
