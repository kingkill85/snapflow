package attrschema_test

import (
	"reflect"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

func TestParseDecimal(t *testing.T) {
	ok := map[string]string{
		"2,5": "2.5", "2.5": "2.5", " 27 ": "27", "-3": "-3", "+4,25": "4.25", "0,5": "0.5", ",5": "0.5",
		"1.234,56": "1234.56", "1,234.56": "1234.56", "1.234.567": "1234567", "1,234,567": "1234567",
		"1 234,5": "1234.5", "1 234.5": "1234.5", "12'345.5": "12345.5",
		"1,234": "1.234", "1.234": "1.234", "007": "007",
	}
	for in, want := range ok {
		if got, valid := attrschema.ParseDecimal(in); !valid || got != want {
			t.Errorf("ParseDecimal(%q) = %q, %v; want %q", in, got, valid, want)
		}
	}
	for _, in := range []string{"", "-", "abc", "1e3", "0x1A", "1,2,3.4,5", "1.23.4", "12.34.56,7,8", "1,", "1.", "$5", "5 TE", "1.2345.678", "12345,678,9"} {
		if got, valid := attrschema.ParseDecimal(in); valid {
			t.Errorf("ParseDecimal(%q) = %q, want invalid", in, got)
		}
	}
}

func TestParseCell(t *testing.T) {
	options := []attrschema.AttributeOption{
		{Key: "zigbee", Label: i18n.Text{"en": "Zigbee"}},
		{Key: "knx", Label: i18n.Text{"en": "KNX  bus", "de": "KNX-Bus"}},
	}
	def := func(t attrschema.Type) attrschema.Definition {
		return attrschema.Definition{Key: "k", Type: t, Options: options}
	}
	list := func(item attrschema.Type) attrschema.Definition {
		return attrschema.Definition{Key: "k", Type: attrschema.TypeList, ItemType: item, Options: options}
	}
	cases := []struct {
		name string
		def  attrschema.Definition
		cell string
		want any
	}{
		{"blank", def(attrschema.TypeText), " \t\n ", nil},
		{"text collapsed", def(attrschema.TypeText), "  86*86  x\n10 mm ", "86*86 x 10 mm"},
		{"number comma", def(attrschema.TypeNumber), "2,5", 2.5},
		{"number point", def(attrschema.TypeNumber), " 2.5 ", 2.5},
		{"number grouped de", def(attrschema.TypeNumber), "1.234,5", 1234.5},
		{"number grouped en", def(attrschema.TypeNumber), "1,234.5", 1234.5},
		{"number negative", def(attrschema.TypeNumber), "-0,25", -0.25},
		{"number invalid passes text", def(attrschema.TypeNumber), "abc", "abc"},
		{"integer", def(attrschema.TypeInteger), "4", 4.0},
		{"integer not whole stays number", def(attrschema.TypeInteger), "4,5", 4.5},
		{"bool yes", def(attrschema.TypeBoolean), "Yes", true},
		{"bool no", def(attrschema.TypeBoolean), "NO", false},
		{"bool ja", def(attrschema.TypeBoolean), "ja", true},
		{"bool nein", def(attrschema.TypeBoolean), "Nein", false},
		{"bool true", def(attrschema.TypeBoolean), "TRUE", true},
		{"bool false", def(attrschema.TypeBoolean), "false", false},
		{"bool 1", def(attrschema.TypeBoolean), "1", true},
		{"bool 0", def(attrschema.TypeBoolean), "0", false},
		{"bool x", def(attrschema.TypeBoolean), "X", true},
		{"bool invalid", def(attrschema.TypeBoolean), "maybe", "maybe"},
		{"enum key", def(attrschema.TypeEnum), "ZIGBEE", "zigbee"},
		{"enum en label", def(attrschema.TypeEnum), "knx bus", "knx"},
		{"enum de label", def(attrschema.TypeEnum), "knx-bus", "knx"},
		{"enum label collapsed", def(attrschema.TypeEnum), " KNX   Bus ", "knx"},
		{"enum unknown", def(attrschema.TypeEnum), "Thread", "Thread"},
		{"list comma", list(attrschema.TypeText), "a, b ,c", []any{"a", "b", "c"}},
		{"list semicolon", list(attrschema.TypeNumber), "2,5; 3,5", []any{2.5, 3.5}},
		{"list newlines", list(attrschema.TypeText), "one\ntwo\r\nthree", []any{"one", "two", "three"}},
		{"list blank items dropped", list(attrschema.TypeText), "a,, ,b,", []any{"a", "b"}},
		{"list enums by label", list(attrschema.TypeEnum), "Zigbee; KNX-Bus", []any{"zigbee", "knx"}},
		{"list items collapsed", list(attrschema.TypeText), "a  b;  c", []any{"a b", "c"}},
		{"list empty", list(attrschema.TypeText), " ; ;\n ", nil},
		{"list only commas", list(attrschema.TypeText), " , ,", nil},
		{"list integer", list(attrschema.TypeInteger), "1,2,3", []any{1.0, 2.0, 3.0}},
	}
	for _, c := range cases {
		if got := attrschema.ParseCell(c.def, c.cell); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ParseCell(%q) = %#v, want %#v", c.name, c.cell, got, c.want)
		}
	}
}

// ParseCell feeds ValidateValues: what it cannot convert comes back with
// the usual codes.
func TestParseCellFeedsValidateValues(t *testing.T) {
	schema := attrschema.Schema{
		{Definition: attrschema.Definition{Key: "width", Type: attrschema.TypeInteger}},
		{Definition: attrschema.Definition{Key: "bus", Type: attrschema.TypeEnum, Options: []attrschema.AttributeOption{{Key: "zigbee", Label: i18n.Text{"en": "Zigbee"}}}}},
		{Definition: attrschema.Definition{Key: "dimmable", Type: attrschema.TypeBoolean}},
	}
	values := map[string]any{}
	for _, a := range schema {
		values[a.Key] = attrschema.ParseCell(a.Definition, map[string]string{"width": "4,5", "bus": "Thread", "dimmable": "ja"}[a.Key])
	}
	valid, _, errs := attrschema.ValidateValues(schema, values, "row", attrschema.Options{Unknown: attrschema.UnknownReject})
	if !reflect.DeepEqual(valid, map[string]any{"dimmable": true}) {
		t.Errorf("valid: %v", valid)
	}
	codes := map[string]string{}
	for _, e := range errs {
		codes[e.Location] = e.Code
	}
	if !reflect.DeepEqual(codes, map[string]string{"row.width": "attribute.type", "row.bus": "attribute.option"}) {
		t.Errorf("errors: %v", codes)
	}
}
