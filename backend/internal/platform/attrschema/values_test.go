package attrschema

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// testSchema has one attribute per type; "colour" is a variant attribute.
func testSchema() Schema {
	s, err := ValidateSchema(Schema{
		with(def("name", TypeText), func(d *AttributeDefinition) { d.Min, d.Max = f(2), f(5) }),
		with(def("power_w", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(0), f(10.5) }),
		with(def("width_te", TypeInteger), func(d *AttributeDefinition) { d.Required = true; d.Min = f(1) }),
		def("dimmable", TypeBoolean),
		with(def("bus_system", TypeEnum), func(d *AttributeDefinition) { d.Options = opts("zigbee", "knx") }),
		with(def("buses", TypeList), func(d *AttributeDefinition) {
			d.ItemType = TypeEnum
			d.Options = opts("zigbee", "knx")
			d.Max = f(2)
		}),
		with(def("tags", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Min = f(1) }),
		with(def("loads", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeInteger }),
		with(def("weights", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeNumber }),
		with(def("colour", TypeText), func(d *AttributeDefinition) { d.Scope = ScopeVariant; d.Required = true }),
		with(def("finish", TypeEnum), func(d *AttributeDefinition) { d.Scope = ScopeVariant; d.Options = opts("matt") }),
	}, "s")
	if err != nil {
		panic(err)
	}
	return s
}

func TestValidateValuesErrors(t *testing.T) {
	const loc = "body.attributes"
	cases := map[string]struct {
		values map[string]any
		want   []string
	}{
		"only the required value":      {map[string]any{"width_te": 2.0}, nil},
		"required missing":             {map[string]any{}, []string{"body.attributes.width_te attribute.required"}},
		"required null":                {map[string]any{"width_te": nil}, []string{"body.attributes.width_te attribute.required"}},
		"text type":                    {map[string]any{"width_te": 1, "name": 12.0}, []string{"body.attributes.name attribute.type"}},
		"text too short":               {map[string]any{"width_te": 1, "name": " a "}, []string{"body.attributes.name attribute.length"}},
		"text too long":                {map[string]any{"width_te": 1, "name": "abcdef"}, []string{"body.attributes.name attribute.length"}},
		"text at min length":           {map[string]any{"width_te": 1, "name": "ab"}, nil},
		"text at max length":           {map[string]any{"width_te": 1, "name": "abcde"}, nil},
		"text length counts runes":     {map[string]any{"width_te": 1, "name": "äöüßé"}, nil},
		"number type":                  {map[string]any{"width_te": 1, "power_w": "5"}, []string{"body.attributes.power_w attribute.type"}},
		"number above max":             {map[string]any{"width_te": 1, "power_w": 10.6}, []string{"body.attributes.power_w attribute.range"}},
		"number below min":             {map[string]any{"width_te": 1, "power_w": -1}, []string{"body.attributes.power_w attribute.range"}},
		"number at min":                {map[string]any{"width_te": 1, "power_w": 0}, nil},
		"number at max":                {map[string]any{"width_te": 1, "power_w": 10.5}, nil},
		"number not finite":            {map[string]any{"width_te": 1, "power_w": math.Inf(1)}, []string{"body.attributes.power_w attribute.type"}},
		"json number beyond float64":   {map[string]any{"width_te": 1, "power_w": json.Number("1e400")}, []string{"body.attributes.power_w attribute.type"}},
		"json number not a number":     {map[string]any{"width_te": 1, "power_w": json.Number("abc")}, []string{"body.attributes.power_w attribute.type"}},
		"json integer beyond float64":  {map[string]any{"width_te": json.Number("1e400")}, []string{"body.attributes.width_te attribute.type"}},
		"json integer not a number":    {map[string]any{"width_te": json.Number("abc")}, []string{"body.attributes.width_te attribute.type"}},
		"integer with fraction":        {map[string]any{"width_te": 1.5}, []string{"body.attributes.width_te attribute.type"}},
		"integer as text":              {map[string]any{"width_te": "2"}, []string{"body.attributes.width_te attribute.type"}},
		"integer below min":            {map[string]any{"width_te": 0}, []string{"body.attributes.width_te attribute.range_min"}},
		"integer at min":               {map[string]any{"width_te": 1}, nil},
		"integer at 2^53-1":            {map[string]any{"width_te": json.Number("9007199254740991")}, nil},
		"integer at 2^53":              {map[string]any{"width_te": json.Number("9007199254740992")}, []string{"body.attributes.width_te attribute.range"}},
		"integer float at 2^53":        {map[string]any{"width_te": float64(1 << 53)}, []string{"body.attributes.width_te attribute.range"}},
		"integer beyond int64":         {map[string]any{"width_te": 1e19}, []string{"body.attributes.width_te attribute.range"}},
		"json integer beyond int64":    {map[string]any{"width_te": json.Number("99999999999999999999")}, []string{"body.attributes.width_te attribute.range"}},
		"json integer in exponent":     {map[string]any{"width_te": json.Number("2e1")}, nil},
		"list item beyond 2^53-1":      {map[string]any{"width_te": 1, "loads": []any{1, -1e16}}, []string{"body.attributes.loads[1] attribute.range"}},
		"boolean type":                 {map[string]any{"width_te": 1, "dimmable": "yes"}, []string{"body.attributes.dimmable attribute.type"}},
		"enum type":                    {map[string]any{"width_te": 1, "bus_system": 1}, []string{"body.attributes.bus_system attribute.type"}},
		"enum option":                  {map[string]any{"width_te": 1, "bus_system": "dali"}, []string{"body.attributes.bus_system attribute.option"}},
		"list type":                    {map[string]any{"width_te": 1, "buses": "zigbee"}, []string{"body.attributes.buses attribute.type"}},
		"list item option":             {map[string]any{"width_te": 1, "buses": []any{"knx", "dali"}}, []string{"body.attributes.buses[1] attribute.option"}},
		"list item type":               {map[string]any{"width_te": 1, "loads": []any{1, "2"}}, []string{"body.attributes.loads[1] attribute.type"}},
		"list item fraction":           {map[string]any{"width_te": 1, "loads": []any{1.5}}, []string{"body.attributes.loads[0] attribute.type"}},
		"list item number type":        {map[string]any{"width_te": 1, "weights": []any{true}}, []string{"body.attributes.weights[0] attribute.type"}},
		"list item blank":              {map[string]any{"width_te": 1, "tags": []any{"a", " "}}, []string{"body.attributes.tags[1] attribute.required"}},
		"list item null":               {map[string]any{"width_te": 1, "tags": []any{nil}}, []string{"body.attributes.tags[0] attribute.required"}},
		"repeated options once":        {map[string]any{"width_te": 1, "buses": []any{"knx", "zigbee", "knx"}}, nil},
		"unknown keys sorted":          {map[string]any{"width_te": 1, "zeta": 1, "alpha": nil}, []string{"body.attributes.alpha attribute.unknown", "body.attributes.zeta attribute.unknown"}},
		"variant key on product":       {map[string]any{"width_te": 1, "colour": "white"}, []string{"body.attributes.colour attribute.wrong_scope"}},
		"wrong scope and unknown keys": {map[string]any{"width_te": 1, "finish": "matt", "colour": nil, "x": 1}, []string{"body.attributes.colour attribute.wrong_scope", "body.attributes.finish attribute.wrong_scope", "body.attributes.x attribute.unknown"}},
		"several errors at once":       {map[string]any{"name": 1, "dimmable": 1}, []string{"body.attributes.name attribute.type", "body.attributes.width_te attribute.required", "body.attributes.dimmable attribute.type"}},
		"json numbers are accepted":    {map[string]any{"width_te": json.Number("3"), "power_w": json.Number("2.5")}, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, errs := ValidateValues(testSchema(), tc.values, loc, Options{})
			got := pairs(errs)
			if len(got) == 0 {
				got = nil
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestValidateValuesParams(t *testing.T) {
	maxSafe := float64(MaxSafeInteger)
	cases := map[string]struct {
		values map[string]any
		want   apperr.FieldError
	}{
		"value between": {map[string]any{"width_te": 1, "power_w": 11},
			apperr.Field("v.power_w", "attribute.range", "").With("min", 0.0).With("max", 10.5)},
		"value min only": {map[string]any{"width_te": 0},
			apperr.Field("v.width_te", "attribute.range_min", "").With("min", 1.0)},
		"integer beyond 2^53-1": {map[string]any{"width_te": 1e16},
			apperr.Field("v.width_te", "attribute.range", "").With("min", -maxSafe).With("max", maxSafe)},
		"length between": {map[string]any{"width_te": 1, "name": "a"},
			apperr.Field("v.name", "attribute.length", "").With("min", 2.0).With("max", 5.0)},
		"repeated options stay within max": {map[string]any{"width_te": 1, "buses": []any{"knx", "zigbee", "knx"}, "loads": []any{1}}, apperr.FieldError{}},
		"type": {map[string]any{"width_te": "1"},
			apperr.Field("v.width_te", "attribute.type", "").With("expected", "integer")},
		"list type": {map[string]any{"width_te": 1, "tags": "a"},
			apperr.Field("v.tags", "attribute.type", "").With("expected", "list")},
		"option": {map[string]any{"width_te": 1, "bus_system": "dali"},
			apperr.Field("v.bus_system", "attribute.option", "").With("options", []string{"zigbee", "knx"})},
		"wrong scope": {map[string]any{"width_te": 1, "colour": "white"},
			apperr.Field("v.colour", "attribute.wrong_scope", "").With("scope", "variant")},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, errs := ValidateValues(testSchema(), tc.values, "v", Options{})
			if tc.want.Code == "" {
				if len(errs) > 0 {
					t.Errorf("got %+v", errs)
				}
				return
			}
			if len(errs) != 1 {
				t.Fatalf("got %+v", errs)
			}
			errs[0].Detail = ""
			if !reflect.DeepEqual(errs[0], tc.want) {
				t.Errorf("got  %+v\nwant %+v", errs[0], tc.want)
			}
		})
	}
}

func TestValidateValuesListCount(t *testing.T) {
	list := func(change func(d *AttributeDefinition)) Schema {
		return Schema{with(def("tags", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; change(d) })}
	}
	cases := map[string]struct {
		schema Schema
		want   map[int]string
	}{
		"between": {list(func(d *AttributeDefinition) { d.Min, d.Max = f(2), f(3) }),
			map[int]string{1: "attribute.count", 2: "", 3: "", 4: "attribute.count"}},
		"min only": {list(func(d *AttributeDefinition) { d.Min = f(2) }),
			map[int]string{1: "attribute.count_min", 2: "", 9: ""}},
		"max only": {list(func(d *AttributeDefinition) { d.Max = f(2) }),
			map[int]string{1: "", 2: "", 3: "attribute.count_max"}},
	}
	for name, tc := range cases {
		for n, want := range tc.want {
			items := make([]any, n)
			for i := range items {
				items[i] = strings.Repeat("x", i+1)
			}
			_, _, errs := ValidateValues(tc.schema, map[string]any{"tags": items}, "v", Options{})
			got := ""
			if len(errs) > 0 {
				got = errs[0].Code
			}
			if got != want {
				t.Errorf("%s, %d items: got %q, want %q", name, n, got, want)
			}
		}
	}
}

func TestValidateValuesRequiredList(t *testing.T) {
	s := Schema{with(def("buses", TypeList), func(d *AttributeDefinition) {
		d.Required = true
		d.ItemType = TypeEnum
		d.Options = opts("zigbee", "knx")
		d.Min = f(2)
	})}
	cases := map[string]struct {
		value any
		want  []string
	}{
		"empty list":             {[]any{}, []string{"v.buses attribute.required"}},
		"repeats collapse below": {[]any{"knx", "knx"}, []string{"v.buses attribute.count_min"}},
		"two different options":  {[]any{"knx", "zigbee", "knx"}, nil},
	}
	for name, tc := range cases {
		_, _, errs := ValidateValues(s, map[string]any{"buses": tc.value}, "v", Options{})
		got := pairs(errs)
		if len(got) == 0 {
			got = nil
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %q, want %q", name, got, tc.want)
		}
	}
}

func TestValidateValuesNormalises(t *testing.T) {
	got, stale, errs := ValidateValues(testSchema(), map[string]any{
		"name":       "  Dim ",
		"power_w":    3,
		"width_te":   4.0,
		"dimmable":   false,
		"bus_system": " knx ",
		"buses":      []any{"knx", "zigbee", "knx"},
		"tags":       []string{" a ", "b"},
		"loads":      []any{json.Number("7")},
		"weights":    []any{}, // empty list counts as absent
	}, "v", Options{Scope: ScopeProduct})
	if len(errs) > 0 {
		t.Fatal(pairs(errs))
	}
	want := map[string]any{
		"name":       "Dim",
		"power_w":    3.0,
		"width_te":   int64(4),
		"dimmable":   false,
		"bus_system": "knx",
		"buses":      []any{"knx", "zigbee"},
		"tags":       []any{"a", "b"},
		"loads":      []any{int64(7)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %#v\nwant %#v", got, want)
	}
	if stale == nil || len(stale) != 0 {
		t.Errorf("stale: %#v", stale)
	}

	// Blank text and enum count as absent.
	got, _, errs = ValidateValues(testSchema(), map[string]any{"width_te": 1, "name": "  ", "bus_system": ""}, "v", Options{})
	if len(errs) > 0 || len(got) != 1 {
		t.Errorf("blank values: got %v %v", got, pairs(errs))
	}
}

// Values read back from jsonb are float64 (and []any); validating them again
// gives the same normalised values.
func TestValidateValuesRoundTrip(t *testing.T) {
	first, _, errs := ValidateValues(testSchema(), map[string]any{
		"width_te": json.Number("9007199254740991"), "loads": []any{-3}, "power_w": 2.5, "buses": []any{"knx"},
	}, "v", Options{})
	if len(errs) > 0 {
		t.Fatal(pairs(errs))
	}
	raw, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if _, ok := stored["width_te"].(float64); !ok {
		t.Fatalf("jsonb decodes integers as %T", stored["width_te"])
	}
	again, _, errs := ValidateValues(testSchema(), stored, "v", Options{})
	if len(errs) > 0 || !reflect.DeepEqual(again, first) {
		t.Errorf("got %#v %v\nwant %#v", again, pairs(errs), first)
	}
}

func TestValidateValuesUnknown(t *testing.T) {
	values := map[string]any{"width_te": 1, "old_name": "x", "gone": nil, "colour": "white"}

	got, stale, errs := ValidateValues(testSchema(), values, "v", Options{Unknown: UnknownKeep})
	if !reflect.DeepEqual(pairs(errs), []string{"v.colour attribute.wrong_scope"}) {
		t.Errorf("keep: errors %q", pairs(errs))
	}
	if !reflect.DeepEqual(stale, map[string]any{"old_name": "x", "gone": nil}) {
		t.Errorf("keep: stale %#v", stale)
	}
	if !reflect.DeepEqual(got, map[string]any{"width_te": int64(1)}) {
		t.Errorf("keep: values %#v", got)
	}

	_, stale, errs = ValidateValues(testSchema(), values, "v", Options{Unknown: UnknownReject})
	want := []string{"v.colour attribute.wrong_scope", "v.gone attribute.unknown", "v.old_name attribute.unknown"}
	if !reflect.DeepEqual(pairs(errs), want) || len(stale) != 0 {
		t.Errorf("reject: errors %q, stale %v", pairs(errs), stale)
	}
}

func TestValidateValuesScopes(t *testing.T) {
	s := testSchema()

	got, _, errs := ValidateValues(s, map[string]any{"colour": " white "}, "v", Options{Scope: ScopeVariant})
	if len(errs) > 0 || got["colour"] != "white" {
		t.Errorf("variant: got %v %v", got, pairs(errs))
	}
	// A required variant attribute is required on the variant, not on the
	// product.
	_, _, errs = ValidateValues(s, map[string]any{}, "v", Options{Scope: ScopeVariant})
	if !reflect.DeepEqual(pairs(errs), []string{"v.colour attribute.required"}) {
		t.Errorf("variant required: got %v", pairs(errs))
	}
	_, _, errs = ValidateValues(s, map[string]any{"width_te": 1}, "v", Options{Scope: ScopeProduct})
	if len(errs) > 0 {
		t.Errorf("product without the variant's required value: got %v", pairs(errs))
	}
	_, _, errs = ValidateValues(s, map[string]any{"colour": "w", "width_te": 1}, "v", Options{Scope: ScopeVariant})
	if !reflect.DeepEqual(pairs(errs), []string{"v.width_te attribute.wrong_scope"}) {
		t.Errorf("product key on variant: got %v", pairs(errs))
	}

	// An instance schema applies every attribute.
	inst := instance(def("mac", TypeText), with(def("address", TypeInteger), func(d *AttributeDefinition) { d.Required = true }))
	got, _, errs = ValidateInstanceValues(inst, map[string]any{"mac": "aa", "address": 3}, "v", Options{Scope: ScopeVariant})
	if len(errs) > 0 || len(got) != 2 {
		t.Errorf("instance: got %v %v", got, pairs(errs))
	}
	_, _, errs = ValidateInstanceValues(inst, map[string]any{"x": 1}, "v", Options{})
	if !reflect.DeepEqual(pairs(errs), []string{"v.address attribute.required", "v.x attribute.unknown"}) {
		t.Errorf("instance errors: got %v", pairs(errs))
	}
	if out, stale, _ := ValidateInstanceValues(inst, nil, "v", Options{}); out == nil || stale == nil {
		t.Error("the results must never be nil")
	}
}
