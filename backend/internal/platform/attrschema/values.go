package attrschema

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// Unknown says what ValidateValues does with keys the schema does not have.
type Unknown int

const (
	// UnknownReject reports them as attribute.unknown (strict, e.g. imports:
	// a typo must not be stored silently).
	UnknownReject Unknown = iota
	// UnknownKeep returns them untouched as stale values, without errors
	// (product saves: renaming an attribute must not block saving or
	// silently delete data).
	UnknownKeep
)

// Options control ValidateValues.
type Options struct {
	// Scope selects the attributes of a product schema that apply:
	// ScopeProduct (the default when empty) or ScopeVariant. Ignored for
	// instance schemas.
	Scope Scope
	// Unknown handles keys that are not in the schema.
	Unknown Unknown
}

// ValidateValues checks the values of one product or variant against s and
// returns them normalised: text trimmed, numbers as float64, integers as
// int64, lists as []any, absent and empty values left out.
//
// Keys of attributes with the other scope are reported as
// attribute.wrong_scope. Keys the schema does not have are reported as
// attribute.unknown, or with UnknownKeep returned untouched in stale.
// Errors are located at location + "." + key (list items at "key[i]").
func ValidateValues(s Schema, values map[string]any, location string, opts Options) (valid, stale map[string]any, errs []apperr.FieldError) {
	scope := opts.Scope
	if scope == "" {
		scope = ScopeProduct
	}
	defs := make([]scopedDefinition, len(s))
	for i, a := range s {
		defs[i] = scopedDefinition{a.Definition, a.Scope}
		if defs[i].scope == "" {
			defs[i].scope = ScopeProduct
		}
	}
	return validateValues(defs, scope, values, location, opts.Unknown)
}

// ValidateInstanceValues is ValidateValues for an installed unit; every
// attribute of the instance schema applies (opts.Scope is ignored).
func ValidateInstanceValues(s InstanceSchema, values map[string]any, location string, opts Options) (valid, stale map[string]any, errs []apperr.FieldError) {
	defs := make([]scopedDefinition, len(s))
	for i, a := range s {
		defs[i] = scopedDefinition{Definition: a.Definition}
	}
	return validateValues(defs, "", values, location, opts.Unknown)
}

// scopedDefinition is a definition with its scope ("" for instances).
type scopedDefinition struct {
	Definition
	scope Scope
}

func validateValues(defs []scopedDefinition, scope Scope, values map[string]any, location string, unknown Unknown) (map[string]any, map[string]any, []apperr.FieldError) {
	valid, stale := map[string]any{}, map[string]any{}
	var errs []apperr.FieldError
	known := map[string]Scope{}
	for _, d := range defs {
		known[d.Key] = d.scope
		if d.scope != scope {
			continue
		}
		loc := location + "." + d.Key
		v, err := d.value(values[d.Key], loc)
		switch {
		case err != nil:
			errs = append(errs, *err)
		case v == nil:
			if d.Required {
				errs = append(errs, apperr.Field(loc, "attribute.required", "value is required"))
			}
		default:
			valid[d.Key] = v
		}
	}

	others := make([]string, 0)
	for k := range values {
		if s, ok := known[k]; !ok || s != scope {
			others = append(others, k)
		}
	}
	sort.Strings(others)
	for _, k := range others {
		loc := location + "." + k
		switch s, ok := known[k]; {
		case ok:
			errs = append(errs, apperr.Field(loc, "attribute.wrong_scope", "the attribute is set per "+string(s)).With("scope", string(s)))
		case unknown == UnknownKeep:
			stale[k] = values[k]
		default:
			errs = append(errs, apperr.Field(loc, "attribute.unknown", "no such attribute"))
		}
	}
	return valid, stale, errs
}

// value normalises one value; nil means absent.
func (d Definition) value(v any, loc string) (any, *apperr.FieldError) {
	if v == nil {
		return nil, nil
	}
	if d.Type != TypeList {
		n, err := scalar(d.Type, d.Options, v, loc)
		if err != nil || n == nil {
			return nil, err
		}
		if x, prefix, bounded := measure(d.Type, n); bounded && !inRange(x, d.Min, d.Max) {
			return nil, ptr(rangeErr(loc, prefix, d.Min, d.Max))
		}
		return n, nil
	}

	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, ptr(typeErr(loc, TypeList))
	}
	items := make([]any, 0, rv.Len())
	for i := range rv.Len() {
		iloc := fmt.Sprintf("%s[%d]", loc, i)
		item := rv.Index(i).Interface()
		if item == nil {
			return nil, ptr(apperr.Field(iloc, "attribute.required", "list items cannot be empty"))
		}
		n, err := scalar(d.ItemType, d.Options, item, iloc)
		if err != nil {
			return nil, err
		}
		if n == nil {
			return nil, ptr(apperr.Field(iloc, "attribute.required", "list items cannot be empty"))
		}
		// A list of options is a set: repeating an option adds nothing.
		if d.ItemType == TypeEnum && slices.Contains(items, n) {
			continue
		}
		items = append(items, n)
	}
	if len(items) == 0 {
		return nil, nil
	}
	if !inRange(float64(len(items)), d.Min, d.Max) {
		return nil, ptr(rangeErr(loc, "attribute.count", d.Min, d.Max))
	}
	return items, nil
}

// scalar normalises a single value of type t; nil means absent (blank text).
func scalar(t Type, options []AttributeOption, v any, loc string) (any, *apperr.FieldError) {
	switch t {
	case TypeText:
		s, ok := v.(string)
		if !ok {
			return nil, ptr(typeErr(loc, t))
		}
		if s = strings.TrimSpace(s); s == "" {
			return nil, nil
		}
		return s, nil
	case TypeNumber:
		f, ok := toFloat(v)
		if !ok {
			return nil, ptr(typeErr(loc, t))
		}
		return f, nil
	case TypeInteger:
		f, ok := toWhole(v)
		if !ok {
			return nil, ptr(typeErr(loc, t))
		}
		if math.Abs(f) > MaxSafeInteger {
			lo, hi := float64(-MaxSafeInteger), float64(MaxSafeInteger)
			return nil, ptr(rangeErr(loc, "attribute.range", &lo, &hi))
		}
		return int64(f), nil
	case TypeBoolean:
		b, ok := v.(bool)
		if !ok {
			return nil, ptr(typeErr(loc, t))
		}
		return b, nil
	case TypeEnum:
		s, ok := v.(string)
		if !ok {
			return nil, ptr(typeErr(loc, t))
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, nil
		}
		if !slices.ContainsFunc(options, func(o AttributeOption) bool { return o.Key == s }) {
			keys := make([]string, len(options))
			for i, o := range options {
				keys[i] = o.Key
			}
			return nil, ptr(apperr.Field(loc, "attribute.option", "not one of the options").With("options", keys))
		}
		return s, nil
	default:
		return nil, ptr(apperr.Field(loc, "validation.invalid", "the attribute's type is invalid"))
	}
}

func typeErr(loc string, expected Type) apperr.FieldError {
	return apperr.Field(loc, "attribute.type", "value must be of type "+string(expected)).With("expected", string(expected))
}

// measure is what Min and Max bound for a scalar: the value (code prefix
// attribute.range) or the length of a text (attribute.length).
func measure(t Type, v any) (x float64, prefix string, bounded bool) {
	switch x := v.(type) {
	case string:
		if t == TypeText {
			return float64(utf8.RuneCountInString(x)), "attribute.length", true
		}
	case float64:
		return x, "attribute.range", true
	case int64:
		return float64(x), "attribute.range", true
	}
	return 0, "", false // not bounded (boolean, enum)
}

func inRange(x float64, lo, hi *float64) bool {
	return (lo == nil || x >= *lo) && (hi == nil || x <= *hi)
}

// rangeErr reports a value outside [lo, hi]. The code says which bounds
// exist, so every message can name them: prefix with both (params min and
// max), prefix+"_min" with only a minimum, prefix+"_max" with only a maximum.
func rangeErr(loc, prefix string, lo, hi *float64) apperr.FieldError {
	switch {
	case lo != nil && hi != nil:
		return apperr.Field(loc, prefix, fmt.Sprintf("must be between %g and %g", *lo, *hi)).With("min", *lo).With("max", *hi)
	case lo != nil:
		return apperr.Field(loc, prefix+"_min", fmt.Sprintf("must be at least %g", *lo)).With("min", *lo)
	default:
		return apperr.Field(loc, prefix+"_max", fmt.Sprintf("must be at most %g", *hi)).With("max", *hi)
	}
}

func toFloat(v any) (float64, bool) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case float32:
		f = float64(x)
	case int:
		f = float64(x)
	case int32:
		f = float64(x)
	case int64:
		f = float64(x)
	case json.Number:
		var err error
		if f, err = x.Float64(); err != nil {
			return 0, false // not a number, or beyond float64 (e.g. 1e400)
		}
	default:
		return 0, false
	}
	return f, !math.IsNaN(f) && !math.IsInf(f, 0)
}

// toWhole returns v if it is a finite whole number. The caller checks the
// range; beyond ±(2^53−1) the float64 may be rounded, but such values are
// rejected anyway.
func toWhole(v any) (float64, bool) {
	if x, isNumber := v.(json.Number); isNumber {
		if i, err := x.Int64(); err == nil {
			return float64(i), true
		}
	}
	f, ok := toFloat(v)
	return f, ok && f == math.Trunc(f)
}
