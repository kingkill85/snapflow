package attrschema

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

func f(v float64) *float64 { return &v }

func label(en string) i18n.Text { return i18n.Text{"en": en} }

func opts(keys ...string) []AttributeOption {
	out := make([]AttributeOption, len(keys))
	for i, k := range keys {
		out[i] = AttributeOption{Key: k, Label: label(strings.ToUpper(k))}
	}
	return out
}

func def(key string, t Type) AttributeDefinition {
	return AttributeDefinition{Definition: Definition{Key: key, Label: label(key), Type: t}}
}

// instance turns product definitions into an instance schema.
func instance(defs ...AttributeDefinition) InstanceSchema {
	out := make(InstanceSchema, len(defs))
	for i, d := range defs {
		out[i] = InstanceAttributeDefinition{d.Definition}
	}
	return out
}

// with applies changes to a copy of d.
func with(d AttributeDefinition, change func(*AttributeDefinition)) AttributeDefinition {
	change(&d)
	return d
}

// fieldErrors returns "location code" pairs of an apperr validation error.
func fieldErrors(t *testing.T, err error) []string {
	t.Helper()
	if err == nil {
		return nil
	}
	var e *apperr.Error
	if !errors.As(err, &e) {
		t.Fatalf("not an apperr: %v", err)
	}
	if e.Status != 422 || e.Code != "validation.failed" {
		t.Fatalf("got %d %s, want 422 validation.failed", e.Status, e.Code)
	}
	return pairs(e.Fields)
}

func pairs(fields []apperr.FieldError) []string {
	out := []string{}
	for _, fe := range fields {
		out = append(out, fe.Location+" "+fe.Code)
	}
	return out
}

func TestValidateSchemaErrors(t *testing.T) {
	cases := map[string]struct {
		instance bool
		schema   Schema
		want     []string
	}{
		"valid schema of every type": {false, Schema{
			def("name", TypeText),
			def("width_te", TypeInteger),
			def("power_w", TypeNumber),
			def("dimmable", TypeBoolean),
			with(def("bus_system", TypeEnum), func(d *AttributeDefinition) { d.Options = opts("zigbee", "knx") }),
			with(def("tags", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText }),
			with(def("buses", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum; d.Options = opts("a") }),
		}, nil},
		"empty schema": {false, Schema{}, nil},
		"key format": {false, Schema{def("Width", TypeText), def("1st", TypeText), with(def("", TypeText), func(d *AttributeDefinition) { d.Label = label("X") }), def("a-b", TypeText)}, []string{
			"body.attributes[0].key attribute.key_format",
			"body.attributes[1].key attribute.key_format",
			"body.attributes[2].key attribute.key_format",
			"body.attributes[3].key attribute.key_format",
		}},
		"key too long": {false, Schema{def("a"+strings.Repeat("b", 64), TypeText)}, []string{
			"body.attributes[0].key validation.too_long",
		}},
		"key duplicate": {false, Schema{def("a", TypeText), def("b", TypeText), def("a", TypeNumber)}, []string{
			"body.attributes[2].key attribute.key_duplicate",
		}},
		"label required": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Label = i18n.Text{"de": "A"} }),
			with(def("b", TypeText), func(d *AttributeDefinition) { d.Label = i18n.Text{"en": "  "} }),
			with(def("c", TypeText), func(d *AttributeDefinition) { d.Label = nil }),
		}, []string{
			"body.attributes[0].label.en attribute.label_required",
			"body.attributes[1].label.en attribute.label_required",
			"body.attributes[2].label.en attribute.label_required",
		}},
		"description needs english": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Description = i18n.Text{"de": "Hilfe"} }),
		}, []string{"body.attributes[0].description.en validation.required"}},
		"unit too long": {false, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Unit = strings.Repeat("x", 17) }),
		}, []string{"body.attributes[0].unit validation.too_long"}},
		"unknown type": {false, Schema{def("a", "date"), def("b", "")}, []string{
			"body.attributes[0].type validation.invalid",
			"body.attributes[1].type validation.invalid",
		}},
		"unknown scope": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Scope = "unit" }),
		}, []string{"body.attributes[0].scope validation.invalid"}},
		"enum without options": {false, Schema{def("a", TypeEnum)}, []string{
			"body.attributes[0].options attribute.options_required",
		}},
		"list of enum without options": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum }),
		}, []string{"body.attributes[0].options attribute.options_required"}},
		"option key format and duplicate": {false, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) { d.Options = opts("x", "Bad", "x") }),
		}, []string{
			"body.attributes[0].options[1].key attribute.key_format",
			"body.attributes[0].options[2].key attribute.option_key_duplicate",
		}},
		"option label required": {false, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) {
				d.Options = []AttributeOption{{Key: "x", Label: i18n.Text{"de": "X"}}}
			}),
		}, []string{"body.attributes[0].options[0].label.en attribute.label_required"}},
		"list without item type": {false, Schema{def("a", TypeList)}, []string{
			"body.attributes[0].itemType attribute.item_type_required",
		}},
		"list with invalid item type": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeBoolean }),
			with(def("b", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeList }),
		}, []string{
			"body.attributes[0].itemType validation.invalid",
			"body.attributes[1].itemType validation.invalid",
		}},
		"min above max": {false, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(5), f(1) }),
		}, []string{"body.attributes[0].max attribute.range_invalid"}},
		"min equal max is fine": {false, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(1), f(1) }),
		}, nil},
		"negative number bounds are fine": {false, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(-20.5), f(-0.5) }),
		}, nil},
		"fractional integer bounds": {false, Schema{
			with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Min, d.Max = f(0.5), f(2.5) }),
		}, []string{
			"body.attributes[0].min attribute.bound_whole",
			"body.attributes[0].max attribute.bound_whole",
		}},
		"negative text length": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Min = f(-1) }),
		}, []string{"body.attributes[0].min attribute.bound_negative"}},
		"negative list count": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Max = f(-1) }),
		}, []string{"body.attributes[0].max attribute.bound_negative"}},
		"fractional list count": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Max = f(1.5) }),
		}, []string{"body.attributes[0].max attribute.bound_whole"}},
		"fractional text length": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Min = f(0.5) }),
		}, []string{"body.attributes[0].min attribute.bound_whole"}},
		"integer bounds beyond 2^53-1": {false, Schema{
			with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Min, d.Max = f(-(1 << 53)), f(1<<53) }),
		}, []string{
			"body.attributes[0].min attribute.bound_range",
			"body.attributes[0].max attribute.bound_range",
		}},
		"integer bounds at 2^53-1 are fine": {false, Schema{
			with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Min, d.Max = f(-(1<<53 - 1)), f(1<<53-1) }),
		}, nil},
		"number bounds are not limited": {false, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(-1e300), f(1e300) }),
		}, nil},
		"min above max is not reported with a bad bound": {false, Schema{
			with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Min, d.Max = f(5.5), f(1) }),
		}, []string{"body.attributes[0].min attribute.bound_whole"}},
		"required text with max 0": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Required = true; d.Max = f(0) }),
		}, []string{"body.attributes[0].max attribute.required_max"}},
		"required list with max 0": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.Required = true; d.ItemType = TypeText; d.Max = f(0) }),
		}, []string{"body.attributes[0].max attribute.required_max"}},
		"optional text with max 0 is fine": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Max = f(0) }),
		}, nil},
		"required text with min 1 max 1 is fine": {false, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Required = true; d.Min, d.Max = f(1), f(1) }),
		}, nil},
		"list of enum with min above the options": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum; d.Options = opts("x", "y"); d.Min = f(3) }),
		}, []string{"body.attributes[0].min attribute.min_above_options"}},
		"list of enum with min equal to the options is fine": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum; d.Options = opts("x", "y"); d.Min = f(2) }),
		}, nil},
		"list of text with a high min is fine": {false, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Min = f(30) }),
		}, nil},
		"unknown locales": {false, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) {
				d.Label = i18n.Text{"en": "A", "fr": "A", "EN": "A"}
				d.Description = i18n.Text{"en": "Help", "es": "Ayuda"}
				d.Options = []AttributeOption{{Key: "x", Label: i18n.Text{"en": "X", "it": "X"}}}
			}),
		}, []string{
			"body.attributes[0].label.EN validation.locale",
			"body.attributes[0].label.fr validation.locale",
			"body.attributes[0].description.es validation.locale",
			"body.attributes[0].options[0].label.it validation.locale",
		}},
		"long label, description and option label": {false, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) {
				d.Label = i18n.Text{"en": strings.Repeat("ä", 100), "de": strings.Repeat("ä", 101)}
				d.Description = i18n.Text{"en": strings.Repeat("x", 501)}
				d.Options = []AttributeOption{{Key: "x", Label: i18n.Text{"en": strings.Repeat("x", 101)}}}
			}),
		}, []string{
			"body.attributes[0].label.de validation.too_long",
			"body.attributes[0].description.en validation.too_long",
			"body.attributes[0].options[0].label.en validation.too_long",
		}},
		"too many options": {false, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) { d.Options = make([]AttributeOption, 501) }),
		}, []string{"body.attributes[0].options validation.too_many"}},
		"too many attributes":          {false, make(Schema, 201), []string{"body.attributes validation.too_many"}},
		"too many instance attributes": {true, make(Schema, 201), []string{"body.attributes validation.too_many"}},
		"errors are collected across attributes": {true, Schema{
			def("Bad", TypeText),
			def("b", TypeEnum),
		}, []string{
			"body.attributes[0].key attribute.key_format",
			"body.attributes[1].options attribute.options_required",
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var err error
			if tc.instance {
				_, err = ValidateInstanceSchema(instance(tc.schema...), "body.attributes")
			} else {
				_, err = ValidateSchema(tc.schema, "body.attributes")
			}
			got := fieldErrors(t, err)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestValidateSchemaNormalises(t *testing.T) {
	a := func(d Definition, scope Scope) AttributeDefinition { return AttributeDefinition{d, scope} }
	in := Schema{
		a(Definition{Key: "a", Label: i18n.Text{"en": " Width ", "de": "  "}, Description: i18n.Text{"en": " "}, Type: TypeText,
			Unit: " TE ", Options: opts("x"), ItemType: TypeText, Min: f(1)}, ""),
		a(Definition{Key: "b", Label: label("B"), Type: TypeBoolean, Min: f(1), Max: f(2)}, ScopeVariant),
		a(Definition{Key: "c", Label: label("C"), Type: TypeEnum, Options: []AttributeOption{{Key: "x", Label: i18n.Text{"en": " X "}}}, Max: f(3)}, ""),
		a(Definition{Key: "d", Label: label("D"), Type: TypeList, ItemType: TypeNumber, Options: opts("x")}, ""),
	}
	got, err := ValidateSchema(in, "body.attributes")
	if err != nil {
		t.Fatal(err)
	}
	want := Schema{
		a(Definition{Key: "a", Label: label("Width"), Type: TypeText, Unit: "TE", Min: f(1)}, ScopeProduct),
		a(Definition{Key: "b", Label: label("B"), Type: TypeBoolean}, ScopeVariant),
		a(Definition{Key: "c", Label: label("C"), Type: TypeEnum, Options: []AttributeOption{{Key: "x", Label: label("X")}}}, ScopeProduct),
		a(Definition{Key: "d", Label: label("D"), Type: TypeList, ItemType: TypeNumber}, ScopeProduct),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if in[2].Options[0].Label["en"] != " X " {
		t.Error("ValidateSchema changed its input")
	}

	inst, err := ValidateInstanceSchema(instance(with(def("mac", TypeText), func(d *AttributeDefinition) { d.Label = label(" MAC ") })), "body.instanceAttributes")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inst, InstanceSchema{{Definition{Key: "mac", Label: label("MAC"), Type: TypeText}}}) {
		t.Errorf("instance: %+v", inst)
	}
	if empty, _ := ValidateSchema(nil, "x"); empty == nil {
		t.Error("an empty schema must normalise to a non-nil slice")
	}
	if empty, _ := ValidateInstanceSchema(nil, "x"); empty == nil {
		t.Error("an empty instance schema must normalise to a non-nil slice")
	}
}

func TestValidateSchemaParams(t *testing.T) {
	cases := map[string]struct {
		def  AttributeDefinition
		want map[string]any
	}{
		"key too long": {def("a"+strings.Repeat("b", 64), TypeText), map[string]any{"max": 64}},
		"unit too long": {with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Unit = strings.Repeat("x", 17) }),
			map[string]any{"max": 16}},
		"min above max": {with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(5), f(1) }),
			map[string]any{"min": 5.0}},
		"integer bound out of range": {with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Max = f(1e16) }),
			map[string]any{"min": float64(-MaxSafeInteger), "max": float64(MaxSafeInteger)}},
		"count bound out of range": {with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Max = f(1e16) }),
			map[string]any{"min": 0.0, "max": float64(MaxSafeInteger)}},
		"required max": {with(def("a", TypeText), func(d *AttributeDefinition) { d.Required = true; d.Max = f(0) }),
			map[string]any{"min": 1}},
		"min above options": {with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum; d.Options = opts("x"); d.Min = f(2) }),
			map[string]any{"max": 1}},
		"too many options": {with(def("a", TypeEnum), func(d *AttributeDefinition) { d.Options = make([]AttributeOption, 501) }),
			map[string]any{"max": 500}},
		"label too long": {with(def("a", TypeText), func(d *AttributeDefinition) { d.Label = label(strings.Repeat("x", 101)) }),
			map[string]any{"max": 100}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, errs := CheckSchema(Schema{tc.def}, "s")
			if len(errs) != 1 || !reflect.DeepEqual(errs[0].Params, tc.want) {
				t.Errorf("got %+v, want params %v", errs, tc.want)
			}
		})
	}
	_, errs := CheckSchema(make(Schema, 201), "s")
	if len(errs) != 1 || !reflect.DeepEqual(errs[0].Params, map[string]any{"max": 200}) {
		t.Errorf("too many attributes: %+v", errs)
	}
}
