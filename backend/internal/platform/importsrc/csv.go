package importsrc

import (
	"bytes"
	"encoding/csv"
	"errors"
	"io"
	"strings"
)

// csvSource is a CSV file: UTF-8 with or without a byte order mark, fields
// separated by ";" or "," (whichever the first line has more of, outside
// quotes), quoted with '"'.
type csvSource struct {
	table *Table
}

func openCSV(data []byte, limits Limits) (Source, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = detectDelimiter(data)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
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
		line, _ := r.FieldPos(0)
		row := Row{Number: line, Cells: record}
		if row.Blank() {
			continue
		}
		if content++; limits.MaxRows > 0 && content > limits.MaxRows {
			return nil, errTooManyRows(limits.MaxRows)
		}
		t.Rows = append(t.Rows, row)
	}
	// Row numbers are the line a record starts on, as a spreadsheet
	// program shows the file (blank lines count, encoding/csv skips them).
	return &csvSource{table: t}, nil
}

// detectDelimiter picks ";" or "," by which occurs more often outside
// quotes in the first line.
func detectDelimiter(data []byte) rune {
	semicolons, commas, quoted := 0, 0, false
	for _, c := range string(data) {
		switch {
		case c == '"':
			quoted = !quoted
		case quoted:
		case c == '\n':
			if semicolons > commas {
				return ';'
			}
			return ','
		case c == ';':
			semicolons++
		case c == ',':
			commas++
		}
	}
	if semicolons > commas {
		return ';'
	}
	return ','
}

func (s *csvSource) Kind() Kind       { return KindCSV }
func (s *csvSource) Sheets() []string { return []string{""} }

func (s *csvSource) Table(sheet string) (*Table, error) {
	if strings.TrimSpace(sheet) != "" {
		return nil, ErrSheetNotFound(sheet)
	}
	return s.table, nil
}
