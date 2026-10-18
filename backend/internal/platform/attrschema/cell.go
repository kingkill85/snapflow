package attrschema

import (
	"strconv"
	"strings"
	"unicode"
)

// ParseCell converts one spreadsheet cell (or a constant of an import
// profile) into a value for ValidateValues, leniently (D32): spreadsheets
// hold text in local formats, ValidateValues stays the one strict rule.
//
//   - Blank cells (only white space) are nil: not set.
//   - Text: white space runs collapse to one space, trimmed.
//   - Numbers and integers: a decimal point or comma, grouping separators
//     when both appear ("1.234,5" and "1,234.5") or repeat ("1.234.567"),
//     spaces as grouping (see ParseDecimal). The result is a float64;
//     ValidateValues checks that an integer is whole.
//   - Booleans: yes/no, ja/nein, true/false, 1/0 and "x" (yes), ignoring
//     case.
//   - Enums: an option's key or its English or German label, ignoring case
//     and repeated white space; the result is the key.
//   - Lists: split on ";" and line breaks if the cell has any, otherwise on
//     "," (so "2,5; 3,5" is two decimal numbers); blank items are dropped and
//     each item is parsed as the item type.
//
// What cannot be converted is passed on as the (collapsed) text, so that
// ValidateValues reports it with its usual code (attribute.type,
// attribute.option).
func ParseCell(d Definition, cell string) any {
	if d.Type == TypeList {
		items := []any{}
		for _, part := range splitList(cell) {
			if v := parseScalar(d.ItemType, d.Options, part); v != nil {
				items = append(items, v)
			}
		}
		if len(items) == 0 {
			return nil
		}
		return items
	}
	return parseScalar(d.Type, d.Options, cell)
}

func parseScalar(t Type, options []AttributeOption, cell string) any {
	s := collapse(cell)
	if s == "" {
		return nil
	}
	switch t {
	case TypeNumber, TypeInteger:
		if d, ok := ParseDecimal(s); ok {
			if f, err := strconv.ParseFloat(d, 64); err == nil {
				return f
			}
		}
	case TypeBoolean:
		switch strings.ToLower(s) {
		case "yes", "ja", "true", "1", "x":
			return true
		case "no", "nein", "false", "0":
			return false
		}
	case TypeEnum:
		want := strings.ToLower(s)
		for _, o := range options {
			if strings.ToLower(o.Key) == want ||
				strings.ToLower(collapse(o.Label["en"])) == want ||
				strings.ToLower(collapse(o.Label["de"])) == want {
				return o.Key
			}
		}
	}
	return s
}

// splitList splits a list cell: on ";" and line breaks if there are any,
// otherwise on ",".
func splitList(cell string) []string {
	if strings.ContainsAny(cell, ";\n\r") {
		return strings.FieldsFunc(cell, func(r rune) bool { return r == ';' || r == '\n' || r == '\r' })
	}
	return strings.Split(cell, ",")
}

func collapse(s string) string {
	return strings.Join(strings.FieldsFunc(s, unicode.IsSpace), " ")
}

// ParseDecimal reads a number as people type it in spreadsheets and returns
// it in the API's form ("-1234.5"): an optional sign, digits, and a decimal
// point or comma. Grouping separators are allowed when the decimal
// separator is the other character ("1.234,5", "1,234.5"), when the same
// separator repeats ("1.234.567"), and as spaces ("1 234,5"); groups after
// the first must have three digits. A single separator is always the
// decimal one ("1,234" is 1.234), as in the editor (D71). No exponents,
// currency signs or units.
func ParseDecimal(s string) (string, bool) {
	s = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '\'' {
			return -1
		}
		return r
	}, s)
	sign := ""
	if s != "" && (s[0] == '-' || s[0] == '+') {
		if s[0] == '-' {
			sign = "-"
		}
		s = s[1:]
	}
	if s == "" {
		return "", false
	}
	dots, commas := strings.Count(s, "."), strings.Count(s, ",")
	var decimal, group string
	switch {
	case dots > 0 && commas > 0:
		if strings.LastIndex(s, ".") > strings.LastIndex(s, ",") {
			decimal, group = ".", ","
		} else {
			decimal, group = ",", "."
		}
		if strings.Count(s, decimal) > 1 {
			return "", false
		}
	case dots > 1:
		group = "."
	case commas > 1:
		group = ","
	case dots == 1:
		decimal = "."
	case commas == 1:
		decimal = ","
	}
	whole, frac := s, ""
	if decimal != "" {
		i := strings.LastIndex(s, decimal)
		whole, frac = s[:i], s[i+1:]
		if frac == "" || !digits(frac) {
			return "", false
		}
	}
	if group != "" {
		parts := strings.Split(whole, group)
		for i, p := range parts {
			if !digits(p) || (i == 0 && len(p) > 3) || (i > 0 && len(p) != 3) {
				return "", false
			}
		}
		whole = strings.Join(parts, "")
	}
	if whole == "" {
		whole = "0"
	}
	if !digits(whole) {
		return "", false
	}
	if frac != "" {
		return sign + whole + "." + frac, true
	}
	return sign + whole, true
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
