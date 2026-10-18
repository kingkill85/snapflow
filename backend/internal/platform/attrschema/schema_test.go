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
	return AttributeDefinition{Key: key, Label: label(key), Type: t}
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
		kind   Kind
		schema Schema
		want   []string
	}{
		"valid schema of every type": {KindProduct, Schema{
			def("name", TypeText),
			def("width_te", TypeInteger),
			def("power_w", TypeNumber),
			def("dimmable", TypeBoolean),
			with(def("bus_system", TypeEnum), func(d *AttributeDefinition) { d.Options = opts("zigbee", "knx") }),
			with(def("tags", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText }),
			with(def("buses", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum; d.Options = opts("a") }),
		}, nil},
		"empty schema": {KindProduct, Schema{}, nil},
		"key format": {KindProduct, Schema{def("Width", TypeText), def("1st", TypeText), with(def("", TypeText), func(d *AttributeDefinition) { d.Label = label("X") }), def("a-b", TypeText)}, []string{
			"body.attributes[0].key attribute.key_format",
			"body.attributes[1].key attribute.key_format",
			"body.attributes[2].key attribute.key_format",
			"body.attributes[3].key attribute.key_format",
		}},
		"key too long": {KindProduct, Schema{def("a"+strings.Repeat("b", 64), TypeText)}, []string{
			"body.attributes[0].key validation.too_long",
		}},
		"key duplicate": {KindProduct, Schema{def("a", TypeText), def("b", TypeText), def("a", TypeNumber)}, []string{
			"body.attributes[2].key attribute.key_duplicate",
		}},
		"label required": {KindProduct, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Label = i18n.Text{"de": "A"} }),
			with(def("b", TypeText), func(d *AttributeDefinition) { d.Label = i18n.Text{"en": "  "} }),
			with(def("c", TypeText), func(d *AttributeDefinition) { d.Label = nil }),
		}, []string{
			"body.attributes[0].label.en attribute.label_required",
			"body.attributes[1].label.en attribute.label_required",
			"body.attributes[2].label.en attribute.label_required",
		}},
		"description needs english": {KindProduct, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Description = i18n.Text{"de": "Hilfe"} }),
		}, []string{"body.attributes[0].description.en validation.required"}},
		"unit too long": {KindProduct, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Unit = strings.Repeat("x", 17) }),
		}, []string{"body.attributes[0].unit validation.too_long"}},
		"unknown type": {KindProduct, Schema{def("a", "date"), def("b", "")}, []string{
			"body.attributes[0].type validation.invalid",
			"body.attributes[1].type validation.invalid",
		}},
		"unknown scope": {KindProduct, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Scope = "unit" }),
		}, []string{"body.attributes[0].scope validation.invalid"}},
		"scope on instance attribute": {KindInstance, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Scope = ScopeVariant }),
		}, []string{"body.attributes[0].scope attribute.scope_not_allowed"}},
		"enum without options": {KindProduct, Schema{def("a", TypeEnum)}, []string{
			"body.attributes[0].options attribute.options_required",
		}},
		"list of enum without options": {KindProduct, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeEnum }),
		}, []string{"body.attributes[0].options attribute.options_required"}},
		"option key format and duplicate": {KindProduct, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) { d.Options = opts("x", "Bad", "x") }),
		}, []string{
			"body.attributes[0].options[1].key attribute.key_format",
			"body.attributes[0].options[2].key attribute.option_key_duplicate",
		}},
		"option label required": {KindProduct, Schema{
			with(def("a", TypeEnum), func(d *AttributeDefinition) {
				d.Options = []AttributeOption{{Key: "x", Label: i18n.Text{"de": "X"}}}
			}),
		}, []string{"body.attributes[0].options[0].label.en attribute.label_required"}},
		"list without item type": {KindProduct, Schema{def("a", TypeList)}, []string{
			"body.attributes[0].itemType attribute.item_type_required",
		}},
		"list with invalid item type": {KindProduct, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeBoolean }),
			with(def("b", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeList }),
		}, []string{
			"body.attributes[0].itemType validation.invalid",
			"body.attributes[1].itemType validation.invalid",
		}},
		"min above max": {KindProduct, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(5), f(1) }),
		}, []string{"body.attributes[0].max attribute.range_invalid"}},
		"min equal max is fine": {KindProduct, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(1), f(1) }),
		}, nil},
		"negative number bounds are fine": {KindProduct, Schema{
			with(def("a", TypeNumber), func(d *AttributeDefinition) { d.Min, d.Max = f(-20.5), f(-0.5) }),
		}, nil},
		"fractional integer bounds": {KindProduct, Schema{
			with(def("a", TypeInteger), func(d *AttributeDefinition) { d.Min, d.Max = f(0.5), f(2.5) }),
		}, []string{
			"body.attributes[0].min attribute.range_invalid",
			"body.attributes[0].max attribute.range_invalid",
		}},
		"negative text length": {KindProduct, Schema{
			with(def("a", TypeText), func(d *AttributeDefinition) { d.Min = f(-1) }),
		}, []string{"body.attributes[0].min attribute.range_invalid"}},
		"fractional list count": {KindProduct, Schema{
			with(def("a", TypeList), func(d *AttributeDefinition) { d.ItemType = TypeText; d.Max = f(1.5) }),
		}, []string{"body.attributes[0].max attribute.range_invalid"}},
		"errors are collected across attributes": {KindInstance, Schema{
			def("Bad", TypeText),
			def("b", TypeEnum),
		}, []string{
			"body.attributes[0].key attribute.key_format",
			"body.attributes[1].options attribute.options_required",
		}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateSchema(tc.schema, tc.kind, "body.attributes")
			got := fieldErrors(t, err)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestValidateSchemaNormalises(t *testing.T) {
	in := Schema{
		{Key: "a", Label: i18n.Text{"en": " Width ", "de": "  "}, Description: i18n.Text{"en": " "}, Type: TypeText,
			Unit: " TE ", Options: opts("x"), ItemType: TypeText, Min: f(1)},
		{Key: "b", Label: label("B"), Type: TypeBoolean, Min: f(1), Max: f(2), Scope: ScopeVariant},
		{Key: "c", Label: label("C"), Type: TypeEnum, Options: []AttributeOption{{Key: "x", Label: i18n.Text{"en": " X "}}}, Max: f(3)},
		{Key: "d", Label: label("D"), Type: TypeList, ItemType: TypeNumber, Options: opts("x")},
	}
	got, err := ValidateSchema(in, KindProduct, "body.attributes")
	if err != nil {
		t.Fatal(err)
	}
	want := Schema{
		{Key: "a", Label: label("Width"), Type: TypeText, Unit: "TE", Min: f(1), Scope: ScopeProduct},
		{Key: "b", Label: label("B"), Type: TypeBoolean, Scope: ScopeVariant},
		{Key: "c", Label: label("C"), Type: TypeEnum, Options: []AttributeOption{{Key: "x", Label: label("X")}}, Scope: ScopeProduct},
		{Key: "d", Label: label("D"), Type: TypeList, ItemType: TypeNumber, Scope: ScopeProduct},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %+v\nwant %+v", got, want)
	}
	if in[2].Options[0].Label["en"] != " X " {
		t.Error("ValidateSchema changed its input")
	}

	inst, err := ValidateSchema(Schema{def("mac", TypeText)}, KindInstance, "body.instanceAttributes")
	if err != nil {
		t.Fatal(err)
	}
	if inst[0].Scope != "" {
		t.Errorf("instance attribute got scope %q", inst[0].Scope)
	}
	if empty, _ := ValidateSchema(nil, KindProduct, "x"); empty == nil {
		t.Error("an empty schema must normalise to a non-nil slice")
	}
}
