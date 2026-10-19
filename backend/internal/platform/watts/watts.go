// Package watts holds the power rule of needs and room template lines
// (D341): power per unit in W is an exact decimal with at most 2 places,
// 0–100000, stored as numeric(9,2) and sent as a decimal string with
// exactly 2 places ("7.50"). Sums are exact (shopspring/decimal), never
// floats.
package watts

import (
	"regexp"

	"github.com/shopspring/decimal"
)

// Places are the decimals of a power value.
const Places = 2

// Max is the highest power per unit.
const Max = 100000

var pattern = regexp.MustCompile(`^\d{1,6}(\.\d{1,2})?$`)

var maxDec = decimal.NewFromInt(Max)

// Parse checks an input value ("7.5", "60", "0.25") and returns it with
// exactly two places; ok is false for anything else (more than 2 places,
// exponent, sign, above Max).
func Parse(s string) (string, bool) {
	if !pattern.MatchString(s) {
		return "", false
	}
	d, err := decimal.NewFromString(s)
	if err != nil || d.GreaterThan(maxDec) {
		return "", false
	}
	return d.StringFixed(Places), true
}

// Format renders a stored numeric with exactly two places.
func Format(s string) string {
	d, err := decimal.NewFromString(s)
	if err != nil {
		return s
	}
	return d.StringFixed(Places)
}

// FormatPtr is Format for a nullable value.
func FormatPtr(s *string) *string {
	if s == nil {
		return nil
	}
	v := Format(*s)
	return &v
}

// Sum adds up quantity × power per unit exactly.
type Sum struct{ d decimal.Decimal }

// Add adds quantity units of power (nil: unknown, adds nothing).
func (s *Sum) Add(quantity int32, power *string) {
	if power == nil {
		return
	}
	d, err := decimal.NewFromString(*power)
	if err != nil {
		return
	}
	s.d = s.d.Add(d.Mul(decimal.NewFromInt32(quantity)))
}

// String is the sum with exactly two places ("0.00" when nothing was added).
func (s Sum) String() string { return s.d.StringFixed(Places) }
