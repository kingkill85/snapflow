// Package attrschema defines attribute schemas: the configurable list of
// attributes a product type gives its products, variants and installed
// units. New attributes are configuration (stored as jsonb), never
// migrations.
//
// ValidateSchema checks and normalises a schema when an admin saves it;
// ValidateValues checks and normalises the values of one product, variant or
// unit against it. Both report per-field errors with stable codes (see
// apperr) at precise locations such as "body.attributes[2].options[0].key".
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

// Kind is the kind of schema being validated.
type Kind int

const (
	// KindProduct schemas describe product and variant values; every
	// attribute has a scope (default "product").
	KindProduct Kind = iota
	// KindInstance schemas describe values per installed unit; they have no
	// scope.
	KindInstance
)

// Limits of a definition.
const (
	MaxKeyLength  = 64
	MaxUnitLength = 16
)

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// AttributeOption is one allowed value of an enum attribute (or of a list of
// enums).
type AttributeOption struct {
	Key   string    `json:"key" doc:"Stored value, lower snake case" example:"zigbee"`
	Label i18n.Text `json:"label" doc:"Display name per locale; \"en\" is required"`
}

// AttributeDefinition defines one attribute.
type AttributeDefinition struct {
	Key         string            `json:"key" doc:"Stable identifier, lower snake case, unique within the schema" example:"width_te"`
	Label       i18n.Text         `json:"label" doc:"Display name per locale; \"en\" is required"`
	Description i18n.Text         `json:"description,omitempty" doc:"Help text per locale; if set, \"en\" is required"`
	Type        Type              `json:"type" enum:"text,number,integer,boolean,enum,list"`
	Required    bool              `json:"required,omitempty" doc:"A value must be set (default false)"`
	Unit        string            `json:"unit,omitempty" doc:"Display only, e.g. TE, mA, W" example:"TE"`
	Min         *float64          `json:"min,omitempty" doc:"number/integer: smallest value; text: shortest length; list: fewest items"`
	Max         *float64          `json:"max,omitempty" doc:"number/integer: largest value; text: longest length; list: most items"`
	Options     []AttributeOption `json:"options,omitempty" maxItems:"500" doc:"Allowed values of an enum, or of a list of enums"`
	ItemType    Type              `json:"itemType,omitempty" enum:"text,number,integer,enum" doc:"Type of a list's items"`
	Scope       Scope             `json:"scope,omitempty" enum:"product,variant" doc:"Product attributes only: set per product (default) or per variant"`
}

// Schema is an ordered list of attribute definitions.
type Schema []AttributeDefinition

// ValidateSchema checks s and returns it normalised: labels and units
// trimmed, the default scope filled in, and fields that do not apply to an
// attribute's type dropped (e.g. options of a text attribute). location is
// the schema's location in the request, e.g. "body.attributes". All problems
// are reported at once as one apperr validation error.
func ValidateSchema(s Schema, kind Kind, location string) (Schema, error) {
	out, errs := CheckSchema(s, kind, location)
	if len(errs) > 0 {
		return nil, apperr.Validation(errs...)
	}
	return out, nil
}

// CheckSchema is ValidateSchema for callers that combine the field errors
// with their own (e.g. a product type's key and name).
func CheckSchema(s Schema, kind Kind, location string) (Schema, []apperr.FieldError) {
	out := make(Schema, 0, len(s))
	var errs []apperr.FieldError
	seen := map[string]bool{}
	for i, d := range s {
		loc := fmt.Sprintf("%s[%d]", location, i)
		d, fieldErrs := normalizeDefinition(d, kind, loc)
		errs = append(errs, fieldErrs...)
		if keyPattern.MatchString(d.Key) {
			if seen[d.Key] {
				errs = append(errs, fieldErr(loc+".key", "attribute.key_duplicate", "key is used twice"))
			}
			seen[d.Key] = true
		}
		out = append(out, d)
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return out, nil
}

func normalizeDefinition(d AttributeDefinition, kind Kind, loc string) (AttributeDefinition, []apperr.FieldError) {
	var errs []apperr.FieldError
	add := func(field, code, detail string) { errs = append(errs, fieldErr(loc+field, code, detail)) }

	if e := checkKey(d.Key, loc+".key"); e != nil {
		errs = append(errs, *e)
	}
	d.Label = d.Label.Trimmed()
	if !d.Label.Valid() {
		add(".label.en", "attribute.label_required", "English label is required")
	}
	d.Description = d.Description.Trimmed()
	if len(d.Description) == 0 {
		d.Description = nil
	} else if !d.Description.Valid() {
		add(".description.en", "validation.required", "English description is required when a description is set")
	}
	d.Unit = strings.TrimSpace(d.Unit)
	if utf8.RuneCountInString(d.Unit) > MaxUnitLength {
		add(".unit", "validation.too_long", fmt.Sprintf("unit is longer than %d characters", MaxUnitLength))
	}

	switch kind {
	case KindProduct:
		switch d.Scope {
		case "":
			d.Scope = ScopeProduct
		case ScopeProduct, ScopeVariant:
		default:
			add(".scope", "validation.invalid", "scope must be product or variant")
		}
	case KindInstance:
		if d.Scope != "" {
			add(".scope", "attribute.scope_not_allowed", "instance attributes have no scope")
		}
	}

	// Drop what does not apply to the type, then check what does.
	bounds, options := false, false
	wholeBounds := false
	switch d.Type {
	case TypeText:
		bounds, wholeBounds = true, true
	case TypeNumber:
		bounds = true
	case TypeInteger:
		bounds, wholeBounds = true, true
	case TypeBoolean:
	case TypeEnum:
		options = true
	case TypeList:
		bounds, wholeBounds = true, true
		switch d.ItemType {
		case "":
			add(".itemType", "attribute.item_type_required", "a list needs an item type")
		case TypeText, TypeNumber, TypeInteger:
		case TypeEnum:
			options = true
		default:
			add(".itemType", "validation.invalid", "item type must be text, number, integer or enum")
		}
	default:
		add(".type", "validation.invalid", "unknown attribute type")
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

	if bounds {
		// Lengths and item counts are whole and not negative; integer
		// bounds are whole.
		nonNegative := d.Type == TypeText || d.Type == TypeList
		badBound := func(b *float64) bool {
			return b != nil && (math.IsNaN(*b) || math.IsInf(*b, 0) ||
				(wholeBounds && *b != math.Trunc(*b)) || (nonNegative && *b < 0))
		}
		if badBound(d.Min) {
			add(".min", "attribute.range_invalid", "invalid minimum")
		}
		if badBound(d.Max) {
			add(".max", "attribute.range_invalid", "invalid maximum")
		}
		if d.Min != nil && d.Max != nil && *d.Min > *d.Max {
			add(".max", "attribute.range_invalid", "maximum is below minimum")
		}
	}

	if options {
		if len(d.Options) == 0 {
			add(".options", "attribute.options_required", "at least one option is required")
		}
		d.Options = slices.Clone(d.Options) // never change the caller's schema
		seen := map[string]bool{}
		for j, o := range d.Options {
			oloc := fmt.Sprintf("%s.options[%d]", loc, j)
			if e := checkKey(o.Key, oloc+".key"); e != nil {
				errs = append(errs, *e)
			} else {
				if seen[o.Key] {
					errs = append(errs, fieldErr(oloc+".key", "attribute.option_key_duplicate", "option key is used twice"))
				}
				seen[o.Key] = true
			}
			d.Options[j].Label = o.Label.Trimmed()
			if !d.Options[j].Label.Valid() {
				errs = append(errs, fieldErr(oloc+".label.en", "attribute.label_required", "English label is required"))
			}
		}
	}
	return d, errs
}

func checkKey(key, loc string) *apperr.FieldError {
	if len(key) > MaxKeyLength {
		e := fieldErr(loc, "validation.too_long", fmt.Sprintf("key is longer than %d characters", MaxKeyLength))
		return &e
	}
	if !keyPattern.MatchString(key) {
		e := fieldErr(loc, "attribute.key_format", "key must be lower snake case")
		return &e
	}
	return nil
}

func fieldErr(location, code, detail string) apperr.FieldError {
	return apperr.FieldError{Location: location, Code: code, Detail: detail}
}
