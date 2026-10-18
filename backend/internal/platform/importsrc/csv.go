package importsrc

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"strings"
)

// csvSource is a CSV file: UTF-8 with or without a byte order mark, fields
// separated by ";" or "," and quoted with '"'. A first line "sep=;" (as
// Excel writes it) sets the delimiter and is not a row; otherwise it is
// detected from the header row on (detectDelimiter).
type csvSource struct {
	table *Table
}

// sniffLines is how many non-blank lines the delimiter detection reads.
const sniffLines = 20

func openCSV(data []byte, limits Limits, opts Options) (Source, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	comma, skip := sepLine(data)
	if skip > 0 {
		data = data[skip:]
	} else {
		comma = detectDelimiter(data, opts.HeaderRow)
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = comma
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.ReuseRecord = false
	t := &Table{}
	content := 0
	for {
		record, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, ErrUnreadable()
		}
		// Row numbers are the line a record starts on, as a spreadsheet
		// program shows the file (blank lines count, encoding/csv skips
		// them; a sep= line does not count, Excel hides it).
		line, _ := r.FieldPos(0)
		row := Row{Number: line, Cells: record}
		if row.Blank() {
			continue
		}
		if limits.MaxColumns > 0 && len(record) > limits.MaxColumns {
			for col := limits.MaxColumns; col < len(record); col++ {
				if strings.TrimSpace(record[col]) != "" {
					return nil, errTooManyColumns(limits.MaxColumns)
				}
			}
			row.Cells = record[:limits.MaxColumns]
		}
		if content++; limits.MaxRows > 0 && content > limits.MaxRows {
			return nil, errTooManyRows(limits.MaxRows)
		}
		t.Rows = append(t.Rows, row)
	}
	return &csvSource{table: t}, nil
}

// sepLine reads a first line "sep=X" (any case, X one character): the
// delimiter and how many bytes the line takes (0 if there is none).
func sepLine(data []byte) (rune, int) {
	end := bytes.IndexByte(data, '\n')
	if end < 0 {
		end = len(data)
	}
	line := strings.TrimRight(string(data[:end]), "\r")
	rest, ok := strings.CutPrefix(strings.ToLower(line), "sep=")
	if !ok || len([]rune(rest)) != 1 || rest == "\"" {
		return 0, 0
	}
	skip := end
	if skip < len(data) {
		skip++
	}
	return []rune(line[4:])[0], skip
}

// detectDelimiter picks ";" or ",": the more consistent one over the first
// sniffLines non-blank lines from the header row on (from the top when it
// is unknown), i.e. the delimiter for which most lines have the same number
// of fields (more than one), then more fields; a tie goes to the one more
// frequent on the header row, then to ";" (the usual delimiter where "," is
// the decimal separator). A title line such as "Preisliste, Stand 2026"
// above a ";" table does not decide it.
func detectDelimiter(data []byte, headerRow int) rune {
	lines := csvLines(data, max(headerRow, 0)+sniffLines)
	from := 0
	if headerRow > 0 && headerRow <= len(lines) {
		from = headerRow - 1
	}
	type score struct{ lines, fields int }
	best := func(count func(csvLine) int) score {
		freq := map[int]int{}
		seen := 0
		for _, l := range lines[from:] {
			if l.blank {
				continue
			}
			if seen++; seen > sniffLines {
				break
			}
			if n := count(l); n > 0 {
				freq[n+1]++
			}
		}
		var s score
		for fields, n := range freq {
			if n > s.lines || (n == s.lines && fields > s.fields) {
				s = score{n, fields}
			}
		}
		return s
	}
	semi := best(func(l csvLine) int { return l.semicolons })
	comma := best(func(l csvLine) int { return l.commas })
	switch {
	case semi.lines == 0 && comma.lines == 0:
		return ','
	case comma.lines != semi.lines:
		return pick(comma.lines > semi.lines)
	case comma.fields != semi.fields:
		return pick(comma.fields > semi.fields)
	}
	if headerRow > 0 && headerRow <= len(lines) {
		if l := lines[headerRow-1]; l.commas != l.semicolons {
			return pick(l.commas > l.semicolons)
		}
	}
	return ';'
}

func pick(comma bool) rune {
	if comma {
		return ','
	}
	return ';'
}

// csvLine counts the delimiters of a physical line outside quotes.
type csvLine struct {
	semicolons, commas int
	blank              bool
}

// csvLines counts the first n physical lines. A line break inside quotes
// adds a blank entry (the record's counts go to the line it ends on), so
// the entries stay aligned with line numbers.
func csvLines(data []byte, n int) []csvLine {
	out := []csvLine{}
	cur := csvLine{blank: true}
	quoted := false
	for _, c := range string(data) {
		switch {
		case c == '"':
			quoted = !quoted
			cur.blank = false
		case quoted && c == '\n':
			out = append(out, csvLine{blank: true})
			if len(out) >= n {
				return out
			}
		case quoted:
		case c == '\n':
			out = append(out, cur)
			if len(out) >= n {
				return out
			}
			cur = csvLine{blank: true}
		case c == ';':
			cur.semicolons++
			cur.blank = false
		case c == ',':
			cur.commas++
			cur.blank = false
		case c != '\r' && c != ' ' && c != '\t':
			cur.blank = false
		}
	}
	return append(out, cur)
}

func (s *csvSource) Kind() Kind       { return KindCSV }
func (s *csvSource) Sheets() []string { return []string{""} }
func (s *csvSource) Close() error     { return nil }

func (s *csvSource) Table(sheet string) (*Table, error) {
	if strings.TrimSpace(sheet) != "" {
		return nil, ErrSheetNotFound(sheet)
	}
	return s.table, nil
}

// ImageData: a CSV file has no pictures.
func (s *csvSource) ImageData(string) ([]byte, error) {
	return nil, ErrUnreadable()
}
