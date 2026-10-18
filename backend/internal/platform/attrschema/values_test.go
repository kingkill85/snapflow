package attrschema

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
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
	}, KindProduct, "s")
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
		"only the required value":   {map[string]any{"width_te": 2.0}, nil},
		"required missing":          {map[string]any{}, []string{"body.attributes.width_te attribute.required"}},
		"required null":             {map[string]any{"width_te": nil}, []string{"body.attributes.width_te attribute.required"}},
		"text type":                 {map[string]any{"width_te": 1, "name": 12.0}, []string{"body.attributes.name attribute.type"}},
		"text too short":            {map[string]any{"width_te": 1, "name": " a "}, []string{"body.attributes.name attribute.range"}},
		"text too long":             {map[string]any{"width_te": 1, "name": "abcdef"}, []string{"body.attributes.name attribute.range"}},
		"text length counts runes":  {map[string]any{"width_te": 1, "name": "äöüßé"}, nil},
		"number type":               {map[string]any{"width_te": 1, "power_w": "5"}, []string{"body.attributes.power_w attribute.type"}},
		"number above max":          {map[string]any{"width_te": 1, "power_w": 10.6}, []string{"body.attributes.power_w attribute.range"}},
		"number below min":          {map[string]any{"width_te": 1, "power_w": -1}, []string{"body.attributes.power_w attribute.range"}},
		"number not finite":         {map[string]any{"width_te": 1, "power_w": math.Inf(1)}, []string{"body.attributes.power_w attribute.type"}},
		"integer with fraction":     {map[string]any{"width_te": 1.5}, []string{"body.attributes.width_te attribute.type"}},
		"integer as text":           {map[string]any{"width_te": "2"}, []string{"body.attributes.width_te attribute.type"}},
		"integer below min":         {map[string]any{"width_te": 0}, []string{"body.attributes.width_te attribute.range"}},
		"integer too large":         {map[string]any{"width_te": 1e19}, []string{"body.attributes.width_te attribute.type"}},
		"boolean type":              {map[string]any{"width_te": 1, "dimmable": "yes"}, []string{"body.attributes.dimmable attribute.type"}},
		"enum type":                 {map[string]any{"width_te": 1, "bus_system": 1}, []string{"body.attributes.bus_system attribute.type"}},
		"enum option":               {map[string]any{"width_te": 1, "bus_system": "dali"}, []string{"body.attributes.bus_system attribute.option"}},
		"list type":                 {map[string]any{"width_te": 1, "buses": "zigbee"}, []string{"body.attributes.buses attribute.type"}},
		"list item option":          {map[string]any{"width_te": 1, "buses": []any{"knx", "dali"}}, []string{"body.attributes.buses[1] attribute.option"}},
		"list item type":            {map[string]any{"width_te": 1, "loads": []any{1, "2"}}, []string{"body.attributes.loads[1] attribute.type"}},
		"list item fraction":        {map[string]any{"width_te": 1, "loads": []any{1.5}}, []string{"body.attributes.loads[0] attribute.type"}},
		"list item number type":     {map[string]any{"width_te": 1, "weights": []any{true}}, []string{"body.attributes.weights[0] attribute.type"}},
		"list item blank":           {map[string]any{"width_te": 1, "tags": []any{"a", " "}}, []string{"body.attributes.tags[1] attribute.required"}},
		"list item null":            {map[string]any{"width_te": 1, "tags": []any{nil}}, []string{"body.attributes.tags[0] attribute.required"}},
		"repeated options once":     {map[string]any{"width_te": 1, "buses": []any{"knx", "zigbee", "knx"}}, nil},
		"unknown keys sorted":       {map[string]any{"width_te": 1, "zeta": 1, "alpha": nil}, []string{"body.attributes.alpha attribute.unknown", "body.attributes.zeta attribute.unknown"}},
		"variant key on product":    {map[string]any{"width_te": 1, "colour": "white"}, []string{"body.attributes.colour attribute.unknown"}},
		"several errors at once":    {map[string]any{"name": 1, "dimmable": 1}, []string{"body.attributes.name attribute.type", "body.attributes.width_te attribute.required", "body.attributes.dimmable attribute.type"}},
		"json numbers are accepted": {map[string]any{"width_te": json.Number("3"), "power_w": json.Number("2.5")}, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, errs := ValidateValues(testSchema(), ScopeProduct, tc.values, loc)
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

func TestValidateValuesListCount(t *testing.T) {
	s := Schema{with(def("tags", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Min, d.Max = f(2), f(3) })}
	for n, want := range map[int]string{1: "attribute.range", 2: "", 3: "", 4: "attribute.range"} {
		items := make([]any, n)
		for i := range items {
			items[i] = strings.Repeat("x", i+1)
		}
		_, errs := ValidateValues(s, "", map[string]any{"tags": items}, "v")
		got := ""
		if len(errs) > 0 {
			got = errs[0].Code
		}
		if got != want {
			t.Errorf("%d items: got %q, want %q", n, got, want)
		}
	}
}

func TestValidateValuesNormalises(t *testing.T) {
	got, errs := ValidateValues(testSchema(), ScopeProduct, map[string]any{
		"name":       "  Dim ",
		"power_w":    3,
		"width_te":   4.0,
		"dimmable":   false,
		"bus_system": " knx ",
		"buses":      []any{"knx", "zigbee", "knx"},
		"tags":       []string{" a ", "b"},
		"loads":      []any{json.Number("7")},
		"weights":    []any{}, // empty list counts as absent
	}, "v")
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

	// Blank text and enum count as absent.
	got, errs = ValidateValues(testSchema(), ScopeProduct, map[string]any{"width_te": 1, "name": "  ", "bus_system": ""}, "v")
	if len(errs) > 0 || len(got) != 1 {
		t.Errorf("blank values: got %v %v", got, pairs(errs))
	}
}

func TestValidateValuesScopes(t *testing.T) {
	s := testSchema()

	got, errs := ValidateValues(s, ScopeVariant, map[string]any{"colour": " white "}, "v")
	if len(errs) > 0 || got["colour"] != "white" {
		t.Errorf("variant: got %v %v", got, pairs(errs))
	}
	_, errs = ValidateValues(s, ScopeVariant, map[string]any{}, "v")
	if !reflect.DeepEqual(pairs(errs), []string{"v.colour attribute.required"}) {
		t.Errorf("variant required: got %v", pairs(errs))
	}
	_, errs = ValidateValues(s, ScopeVariant, map[string]any{"colour": "w", "width_te": 1}, "v")
	if !reflect.DeepEqual(pairs(errs), []string{"v.width_te attribute.unknown"}) {
		t.Errorf("product key on variant: got %v", pairs(errs))
	}

	// An instance schema (scope "") applies every attribute.
	inst := Schema{def("mac", TypeText), with(def("address", TypeInteger), func(d *AttributeDefinition) { d.Required = true })}
	got, errs = ValidateValues(inst, "", map[string]any{"mac": "aa", "address": 3}, "v")
	if len(errs) > 0 || len(got) != 2 {
		t.Errorf("instance: got %v %v", got, pairs(errs))
	}
	if out, _ := ValidateValues(inst, "", nil, "v"); out == nil {
		t.Error("the result must never be nil")
	}
}
