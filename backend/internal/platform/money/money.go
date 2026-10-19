// Package money holds every money rule of SnapFlow (CLAUDE.md rule 1, spec
// 2c): exact decimal amounts, half-up rounding, line totals, discount,
// services, grand total and the conversion of USD amounts into a project's
// currency at the ISO 4217 minor unit. Nothing else computes money; the
// frontend displays what the API returns.
//
// Amounts are decimals (shopspring/decimal), stored as Postgres numeric and
// sent as decimal strings. Catalog amounts are USD (D19) with 2 decimals.
package money

import (
	"errors"
	"strings"

	"github.com/shopspring/decimal"
)

// Amount is an exact decimal amount.
type Amount = decimal.Decimal

// USDPlaces are the decimals of USD amounts.
const USDPlaces = 2

var hundred = decimal.NewFromInt(100)

// Zero is 0.
var Zero = decimal.Zero

// Parse reads a decimal string ("12.5", "0.92"); no exponent, no spaces.
func Parse(s string) (Amount, error) {
	if s == "" || strings.ContainsAny(s, "eE \t") {
		return Zero, errors.New("money: not a decimal")
	}
	return decimal.NewFromString(s)
}

// MustParse is Parse for constants and stored values that are known to be
// valid; it panics on an invalid string.
func MustParse(s string) Amount {
	d, err := Parse(s)
	if err != nil {
		panic(err)
	}
	return d
}

// Round rounds a to places decimals, half up (a half rounds away from zero;
// amounts are never negative).
func Round(a Amount, places int32) Amount { return a.Round(places) }

// RoundUSD rounds to cents, half up.
func RoundUSD(a Amount) Amount { return Round(a, USDPlaces) }

// String formats a with exactly places decimals ("12.50", "1235", "1.235").
func String(a Amount, places int32) string { return a.StringFixed(places) }

// USD formats a USD amount with 2 decimals.
func USD(a Amount) string { return String(a, USDPlaces) }

// LineTotal is unit price × quantity, exact, then rounded half up to cents.
func LineTotal(unitPrice Amount, quantity int64) Amount {
	return RoundUSD(unitPrice.Mul(decimal.NewFromInt(quantity)))
}

// Kind says how a discount or services value applies.
type Kind string

const (
	KindNone    Kind = "none"
	KindPercent Kind = "percent"
	KindAmount  Kind = "amount"
)

// Adjustment is a discount or services setting: a percentage (0–100) or an
// amount in USD.
type Adjustment struct {
	Kind  Kind
	Value Amount
}

// Totals are the USD totals of a version.
type Totals struct {
	Subtotal   Amount
	Discount   Amount
	Services   Amount
	GrandTotal Amount
}

// Compute applies the rules of spec 2c to the goods subtotal:
//   - discount: percent → subtotal × p / 100 rounded to cents; amount → the
//     value; either way capped at the subtotal (never a negative total);
//   - services: percent → (subtotal − discount) × p / 100 rounded; amount →
//     the value;
//   - grand total = subtotal − discount + services.
func Compute(subtotal Amount, discount, services Adjustment) Totals {
	t := Totals{Subtotal: RoundUSD(subtotal), Discount: Zero, Services: Zero}
	switch discount.Kind {
	case KindPercent:
		t.Discount = RoundUSD(t.Subtotal.Mul(discount.Value).Div(hundred))
	case KindAmount:
		t.Discount = RoundUSD(discount.Value)
	}
	if t.Discount.GreaterThan(t.Subtotal) {
		t.Discount = t.Subtotal
	}
	net := t.Subtotal.Sub(t.Discount)
	switch services.Kind {
	case KindPercent:
		t.Services = RoundUSD(net.Mul(services.Value).Div(hundred))
	case KindAmount:
		t.Services = RoundUSD(services.Value)
	}
	t.GrandTotal = net.Add(t.Services)
	return t
}

// Convert turns a USD amount into currency at rate (units of currency per
// 1 USD): usd × rate, rounded half up to the currency's minor unit. Every
// amount is converted on its own from its USD value, so a converted total
// may differ from the sum of converted lines by rounding.
func Convert(usd, rate Amount, currency string) Amount {
	return Round(usd.Mul(rate), MinorUnits(currency))
}
