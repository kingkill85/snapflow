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

// ValidateValues checks the values of one product, variant or installed unit
// against s and returns them normalised: text trimmed, numbers as float64,
// integers as int64, lists as []any, absent and empty values left out.
//
// scope selects the attributes that apply: ScopeProduct or ScopeVariant for a
// product schema, "" for an instance schema (every attribute applies).
// Values for keys that do not apply are reported as attribute.unknown.
// Errors are located at location + "." + key (list items at "key[i]").
func ValidateValues(s Schema, scope Scope, values map[string]any, location string) (map[string]any, []apperr.FieldError) {
	out := map[string]any{}
	var errs []apperr.FieldError
	applies := map[string]bool{}
	for _, d := range s {
		if scope != "" && d.scope() != scope {
			continue
		}
		applies[d.Key] = true
		loc := location + "." + d.Key
		v, err := d.value(values[d.Key], loc)
		switch {
		case err != nil:
			errs = append(errs, *err)
		case v == nil:
			if d.Required {
				errs = append(errs, fieldErr(loc, "attribute.required", "value is required"))
			}
		default:
			out[d.Key] = v
		}
	}

	unknown := make([]string, 0)
	for k := range values {
		if !applies[k] {
			unknown = append(unknown, k)
		}
	}
	sort.Strings(unknown)
	for _, k := range unknown {
		errs = append(errs, fieldErr(location+"."+k, "attribute.unknown", "no such attribute"))
	}
	return out, errs
}

func (d AttributeDefinition) scope() Scope {
	if d.Scope == "" {
		return ScopeProduct
	}
	return d.Scope
}

// value normalises one value; nil means absent.
func (d AttributeDefinition) value(v any, loc string) (any, *apperr.FieldError) {
	if v == nil {
		return nil, nil
	}
	if d.Type != TypeList {
		n, err := scalar(d.Type, d.Options, v, loc)
		if err != nil || n == nil {
			return nil, err
		}
		if !inRange(measure(d.Type, n), d.Min, d.Max) {
			return nil, ptr(fieldErr(loc, "attribute.range", rangeDetail(d.Min, d.Max)))
		}
		return n, nil
	}

	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, ptr(fieldErr(loc, "attribute.type", "value must be a list"))
	}
	items := make([]any, 0, rv.Len())
	for i := range rv.Len() {
		iloc := fmt.Sprintf("%s[%d]", loc, i)
		item := rv.Index(i).Interface()
		if item == nil {
			return nil, ptr(fieldErr(iloc, "attribute.required", "list items cannot be empty"))
		}
		n, err := scalar(d.ItemType, d.Options, item, iloc)
		if err != nil {
			return nil, err
		}
		if n == nil {
			return nil, ptr(fieldErr(iloc, "attribute.required", "list items cannot be empty"))
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
		return nil, ptr(fieldErr(loc, "attribute.range", rangeDetail(d.Min, d.Max)))
	}
	return items, nil
}

// scalar normalises a single value of type t; nil means absent (blank text).
func scalar(t Type, options []AttributeOption, v any, loc string) (any, *apperr.FieldError) {
	typeErr := func(want string) *apperr.FieldError {
		return ptr(fieldErr(loc, "attribute.type", "value must be "+want))
	}
	switch t {
	case TypeText:
		s, ok := v.(string)
		if !ok {
			return nil, typeErr("text")
		}
		if s = strings.TrimSpace(s); s == "" {
			return nil, nil
		}
		return s, nil
	case TypeNumber:
		f, ok := toFloat(v)
		if !ok {
			return nil, typeErr("a number")
		}
		return f, nil
	case TypeInteger:
		i, ok := toInt(v)
		if !ok {
			return nil, typeErr("a whole number")
		}
		return i, nil
	case TypeBoolean:
		b, ok := v.(bool)
		if !ok {
			return nil, typeErr("true or false")
		}
		return b, nil
	case TypeEnum:
		s, ok := v.(string)
		if !ok {
			return nil, typeErr("an option key")
		}
		s = strings.TrimSpace(s)
		if s == "" {
			return nil, nil
		}
		if !slices.ContainsFunc(options, func(o AttributeOption) bool { return o.Key == s }) {
			return nil, ptr(fieldErr(loc, "attribute.option", "not one of the options"))
		}
		return s, nil
	default:
		return nil, ptr(fieldErr(loc, "attribute.type", "the attribute's type is invalid"))
	}
}

// measure is what Min and Max bound for a scalar: the value or the length.
func measure(t Type, v any) float64 {
	switch x := v.(type) {
	case string:
		if t == TypeText {
			return float64(utf8.RuneCountInString(x))
		}
	case float64:
		return x
	case int64:
		return float64(x)
	}
	return math.NaN() // not bounded (boolean, enum)
}

func inRange(x float64, lo, hi *float64) bool {
	if math.IsNaN(x) {
		return true
	}
	return (lo == nil || x >= *lo) && (hi == nil || x <= *hi)
}

func rangeDetail(lo, hi *float64) string {
	switch {
	case lo != nil && hi != nil:
		return fmt.Sprintf("must be between %g and %g", *lo, *hi)
	case lo != nil:
		return fmt.Sprintf("must be at least %g", *lo)
	default:
		return fmt.Sprintf("must be at most %g", *hi)
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
			return 0, false
		}
	default:
		return 0, false
	}
	return f, !math.IsNaN(f) && !math.IsInf(f, 0)
}

func toInt(v any) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int32:
		return int64(x), true
	case int64:
		return x, true
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i, true
		}
	}
	f, ok := toFloat(v)
	// 2^63 is the first float64 above the int64 range.
	if !ok || f != math.Trunc(f) || f < math.MinInt64 || f >= math.MaxInt64 {
		return 0, false
	}
	return int64(f), true
}

func ptr[T any](v T) *T { return &v }
