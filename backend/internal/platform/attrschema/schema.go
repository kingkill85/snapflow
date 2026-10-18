// Package attrschema defines attribute schemas: the configurable list of
// attributes a product type gives its products, variants and installed
// units. New attributes are configuration (stored as jsonb), never
// migrations.
//
// CheckSchema and CheckInstanceSchema check and normalise a schema when an
// admin saves it; ValidateValues and ValidateInstanceValues check and
// normalise the values of one product, variant or unit against it. All
// report per-field errors with stable codes and params (see apperr) at
// precise locations such as "body.attributes[2].options[0].key".
//
// Integers (values and integer bounds) are limited to ±(2^53−1)
// (MaxSafeInteger), the range a float64 and JavaScript represent exactly.
// Values read back from jsonb decode as float64; ValidateValues re-normalises
// them (integers become int64 again), so stored values can be passed through
// it unchanged.
package attrschema

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Type is the value type of an attribute.
type Type string

const (
	TypeText    Type = "text"
	TypeNumber  Type = "number"
	TypeInteger Type = "integer"
	TypeBoolean Type = "boolean"
	TypeEnum    Type = "enum"
	// TypeList holds several values of ItemType.
	TypeList Type = "list"
)

// Scope says where a product attribute's value is set.
type Scope string

const (
	// ScopeProduct values are set once per product.
	ScopeProduct Scope = "product"
	// ScopeVariant values are set per variant (e.g. colour).
	ScopeVariant Scope = "variant"
)

// Limits of a schema.
const (
	MaxAttributes        = 200
	MaxOptions           = 500
	MaxKeyLength         = 64
	MaxUnitLength        = 16
	MaxLabelLength       = 100
	MaxDescriptionLength = 500
	// MaxSafeInteger (2^53−1) bounds integer values and integer bounds.
	MaxSafeInteger = 1<<53 - 1
)

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// AttributeOption is one allowed value of an enum attribute (or of a list of
// enums).
type AttributeOption struct {
	Key   string    `json:"key" doc:"Stored value, lower snake case" example:"zigbee"`
	Label i18n.Text `json:"label" doc:"Display name per locale; \"en\" is required"`
}

// Definition is what every attribute has, product or instance.
type Definition struct {
	Key         string            `json:"key" doc:"Stable identifier, lower snake case, unique within the schema" example:"width_te"`
	Label       i18n.Text         `json:"label" doc:"Display name per locale; \"en\" is required"`
	Description i18n.Text         `json:"description,omitempty" doc:"Help text per locale; if set, \"en\" is required"`
	Type        Type              `json:"type" enum:"text,number,integer,boolean,enum,list"`
	Required    bool              `json:"required,omitempty" doc:"A value must be set (default false)"`
	Unit        string            `json:"unit,omitempty" doc:"Display only, e.g. TE, mA, W" example:"TE"`
	Min         *float64          `json:"min,omitempty" doc:"number/integer: smallest value; text: shortest length; list: fewest items"`
	Max         *float64          `json:"max,omitempty" doc:"number/integer: largest value; text: longest length; list: most items"`
	Options     []AttributeOption `json:"options,omitempty" doc:"Allowed values of an enum, or of a list of enums (at most 500)"`
	ItemType    Type              `json:"itemType,omitempty" enum:"text,number,integer,enum" doc:"Type of a list's items"`
}

// AttributeDefinition defines one product attribute.
type AttributeDefinition struct {
	Definition
	Scope Scope `json:"scope,omitempty" enum:"product,variant" doc:"Set per product (default) or per variant"`
}

// InstanceAttributeDefinition defines one attribute of an installed unit.
type InstanceAttributeDefinition struct {
	Definition
}

// Schema is an ordered list of product attribute definitions.
type Schema []AttributeDefinition

// InstanceSchema is an ordered list of instance attribute definitions.
type InstanceSchema []InstanceAttributeDefinition

// ValidateSchema is CheckSchema returning one apperr validation error.
func ValidateSchema(s Schema, location string) (Schema, error) {
	out, errs := CheckSchema(s, location)
	if len(errs) > 0 {
		return nil, apperr.Validation(errs...)
	}
	return out, nil
}

// ValidateInstanceSchema is CheckInstanceSchema returning one apperr
// validation error.
func ValidateInstanceSchema(s InstanceSchema, location string) (InstanceSchema, error) {
	out, errs := CheckInstanceSchema(s, location)
	if len(errs) > 0 {
		return nil, apperr.Validation(errs...)
	}
	return out, nil
}

// CheckSchema checks a product schema and returns it normalised: texts
// trimmed, the default scope ("product") filled in, and fields that do not
// apply to an attribute's type dropped (e.g. options of a text attribute).
// location is the schema's location in the request, e.g. "body.attributes".
// All problems are returned at once; the schema is nil if there are any.
func CheckSchema(s Schema, location string) (Schema, []apperr.FieldError) {
	if len(s) > MaxAttributes {
		return nil, []apperr.FieldError{tooMany(location, MaxAttributes)}
	}
	out := make(Schema, len(s))
	defs := make([]Definition, len(s))
	for i, a := range s {
		defs[i] = a.Definition
	}
	defs, errs := checkDefinitions(defs, location, func(i int, loc string) []apperr.FieldError {
		switch out[i].Scope = s[i].Scope; out[i].Scope {
		case "":
			out[i].Scope = ScopeProduct
		case ScopeProduct, ScopeVariant:
		default:
			return []apperr.FieldError{apperr.Field(loc+".scope", "validation.invalid", "scope must be product or variant")}
		}
		return nil
	})
	if len(errs) > 0 {
		return nil, errs
	}
	for i := range out {
		out[i].Definition = defs[i]
	}
	return out, nil
}

// CheckInstanceSchema is CheckSchema for an instance schema (no scopes).
func CheckInstanceSchema(s InstanceSchema, location string) (InstanceSchema, []apperr.FieldError) {
	if len(s) > MaxAttributes {
		return nil, []apperr.FieldError{tooMany(location, MaxAttributes)}
	}
	defs := make([]Definition, len(s))
	for i, a := range s {
		defs[i] = a.Definition
	}
	defs, errs := checkDefinitions(defs, location, nil)
	if len(errs) > 0 {
		return nil, errs
	}
	out := make(InstanceSchema, len(defs))
	for i, d := range defs {
		out[i] = InstanceAttributeDefinition{d}
	}
	return out, nil
}

// checkDefinitions normalises defs; extra adds the checks of one kind of
// schema, reported after the definition's own.
func checkDefinitions(defs []Definition, location string, extra func(i int, loc string) []apperr.FieldError) ([]Definition, []apperr.FieldError) {
	out := make([]Definition, 0, len(defs))
	var errs []apperr.FieldError
	seen := map[string]bool{}
	for i, d := range defs {
		loc := fmt.Sprintf("%s[%d]", location, i)
		d, fieldErrs := normalizeDefinition(d, loc)
		errs = append(errs, fieldErrs...)
		if extra != nil {
			errs = append(errs, extra(i, loc)...)
		}
		if keyPattern.MatchString(d.Key) && len(d.Key) <= MaxKeyLength {
			if seen[d.Key] {
				errs = append(errs, apperr.Field(loc+".key", "attribute.key_duplicate", "key is used twice"))
			}
			seen[d.Key] = true
		}
		out = append(out, d)
	}
	return out, errs
}

func normalizeDefinition(d Definition, loc string) (Definition, []apperr.FieldError) {
	var errs []apperr.FieldError
	add := func(e apperr.FieldError) { errs = append(errs, e) }

	if e := checkKey(d.Key, loc+".key"); e != nil {
		add(*e)
	}
	d.Label = d.Label.Trimmed()
	errs = append(errs, d.Label.Check(loc+".label", MaxLabelLength)...)
	if !d.Label.Valid() {
		add(apperr.Field(loc+".label.en", "attribute.label_required", "English label is required"))
	}
	d.Description = d.Description.Trimmed()
	if len(d.Description) == 0 {
		d.Description = nil
	} else {
		errs = append(errs, d.Description.Check(loc+".description", MaxDescriptionLength)...)
		if !d.Description.Valid() {
			add(apperr.Field(loc+".description.en", "validation.required", "English description is required when a description is set"))
		}
	}
	d.Unit = strings.TrimSpace(d.Unit)
	if utf8.RuneCountInString(d.Unit) > MaxUnitLength {
		add(tooLong(loc+".unit", MaxUnitLength))
	}

	// Drop what does not apply to the type, then check what does.
	bounds, options := false, false
	switch d.Type {
	case TypeText, TypeNumber, TypeInteger:
		bounds = true
	case TypeBoolean:
	case TypeEnum:
		options = true
	case TypeList:
		bounds = true
		switch d.ItemType {
		case "":
			add(apperr.Field(loc+".itemType", "attribute.item_type_required", "a list needs an item type"))
		case TypeText, TypeNumber, TypeInteger:
		case TypeEnum:
			options = true
		default:
			add(apperr.Field(loc+".itemType", "validation.invalid", "item type must be text, number, integer or enum"))
		}
	default:
		add(apperr.Field(loc+".type", "validation.invalid", "unknown attribute type"))
		return d, errs
	}
	if d.Type != TypeList {
		d.ItemType = ""
	}
	if !bounds {
		d.Min, d.Max = nil, nil
	}
	if !options {
		d.Options = nil
	}

	var boundErrs []apperr.FieldError
	if bounds {
		boundErrs = checkBounds(d, loc)
		errs = append(errs, boundErrs...)
	}
	if options {
		errs = append(errs, normalizeOptions(&d, loc)...)
		// A list of options is a set, so it never has more items than there
		// are options.
		if d.Type == TypeList && len(boundErrs) == 0 && len(d.Options) > 0 &&
			d.Min != nil && *d.Min > float64(len(d.Options)) {
			errs = append(errs, apperr.Field(loc+".min", "attribute.min_above_options",
				"the minimum is above the number of options").With("max", len(d.Options)))
		}
	}
	return d, errs
}

// checkBounds checks min and max of a type that has bounds.
func checkBounds(d Definition, loc string) []apperr.FieldError {
	var errs []apperr.FieldError
	// Lengths and item counts are whole and not negative; integer bounds are
	// whole. Whole bounds stay within ±MaxSafeInteger.
	whole := d.Type != TypeNumber
	nonNegative := d.Type == TypeText || d.Type == TypeList
	ok := func(b *float64, field string) bool {
		if b == nil {
			return true
		}
		var e *apperr.FieldError
		switch {
		case math.IsNaN(*b) || math.IsInf(*b, 0):
			e = ptr(apperr.Field(loc+field, "validation.invalid", "bound must be a finite number"))
		case whole && *b != math.Trunc(*b):
			e = ptr(apperr.Field(loc+field, "attribute.bound_whole", "bound must be a whole number"))
		case nonNegative && *b < 0:
			e = ptr(apperr.Field(loc+field, "attribute.bound_negative", "length and item count bounds cannot be negative"))
		case whole && math.Abs(*b) > MaxSafeInteger:
			lo := float64(-MaxSafeInteger)
			if nonNegative {
				lo = 0
			}
			e = ptr(apperr.Field(loc+field, "attribute.bound_range", "bound is out of range").
				With("min", lo).With("max", float64(MaxSafeInteger)))
		}
		if e != nil {
			errs = append(errs, *e)
		}
		return e == nil
	}
	minOK, maxOK := ok(d.Min, ".min"), ok(d.Max, ".max")
	if !minOK || !maxOK {
		return errs
	}
	switch {
	case d.Min != nil && d.Max != nil && *d.Min > *d.Max:
		errs = append(errs, apperr.Field(loc+".max", "attribute.range_invalid", "maximum is below minimum").With("min", *d.Min))
	case d.Required && (d.Type == TypeText || d.Type == TypeList) && d.Max != nil && *d.Max < 1:
		// A required value cannot be empty, so it needs room for something.
		errs = append(errs, apperr.Field(loc+".max", "attribute.required_max", "a required value needs a maximum of at least 1").With("min", 1))
	}
	return errs
}

// normalizeOptions checks and trims the options of an enum or list of enums.
func normalizeOptions(d *Definition, loc string) []apperr.FieldError {
	var errs []apperr.FieldError
	switch {
	case len(d.Options) == 0:
		return []apperr.FieldError{apperr.Field(loc+".options", "attribute.options_required", "at least one option is required")}
	case len(d.Options) > MaxOptions:
		return []apperr.FieldError{tooMany(loc+".options", MaxOptions)}
	}
	d.Options = slices.Clone(d.Options) // never change the caller's schema
	seen := map[string]bool{}
	for j, o := range d.Options {
		oloc := fmt.Sprintf("%s.options[%d]", loc, j)
		if e := checkKey(o.Key, oloc+".key"); e != nil {
			errs = append(errs, *e)
		} else {
			if seen[o.Key] {
				errs = append(errs, apperr.Field(oloc+".key", "attribute.option_key_duplicate", "option key is used twice"))
			}
			seen[o.Key] = true
		}
		d.Options[j].Label = o.Label.Trimmed()
		errs = append(errs, d.Options[j].Label.Check(oloc+".label", MaxLabelLength)...)
		if !d.Options[j].Label.Valid() {
			errs = append(errs, apperr.Field(oloc+".label.en", "attribute.label_required", "English label is required"))
		}
	}
	return errs
}

func checkKey(key, loc string) *apperr.FieldError {
	if len(key) > MaxKeyLength {
		return ptr(tooLong(loc, MaxKeyLength))
	}
	if !keyPattern.MatchString(key) {
		return ptr(apperr.Field(loc, "attribute.key_format", "key must be lower snake case"))
	}
	return nil
}

func tooLong(loc string, max int) apperr.FieldError {
	return apperr.Field(loc, "validation.too_long", fmt.Sprintf("longer than %d characters", max)).With("max", max)
}

func tooMany(loc string, max int) apperr.FieldError {
	return apperr.Field(loc, "validation.too_many", fmt.Sprintf("more than %d entries", max)).With("max", max)
}

func ptr[T any](v T) *T { return &v }
