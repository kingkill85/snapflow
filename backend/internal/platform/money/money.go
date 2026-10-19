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
	return USDConverter.Compute(subtotal, discount, services)
}

// Convert turns a USD amount into currency at rate (units of currency per
// 1 USD): usd × rate, rounded half up to the currency's minor unit.
func Convert(usd, rate Amount, currency string) Amount {
	return Round(usd.Mul(rate), MinorUnits(currency))
}

// Converter computes the customer-facing amounts of a project in its
// currency (D267): every unit price is converted and rounded to the
// currency's minor unit, a line total is the converted unit price ×
// quantity, subtotals are sums of converted line totals, a percent
// discount or services value applies to the converted subtotal, an
// absolute one (entered in USD) is converted once; so the printed amounts
// add up in the project currency. The USD figures are computed the same way
// with the USD converter (rate 1) and kept as reference.
type Converter struct {
	Currency string
	Rate     Amount
}

// USDConverter computes USD amounts (rate 1, cents).
var USDConverter = Converter{Currency: "USD", Rate: decimal.NewFromInt(1)}

func (c Converter) places() int32 { return MinorUnits(c.Currency) }

// Round rounds a to the currency's minor unit, half up.
func (c Converter) Round(a Amount) Amount { return Round(a, c.places()) }

// Amount converts a USD amount (unit price, absolute discount or services).
func (c Converter) Amount(usd Amount) Amount { return c.Round(usd.Mul(c.Rate)) }

// LineTotal is the converted unit price × quantity (in USD the exact unit
// price × quantity, rounded: LineTotal).
func (c Converter) LineTotal(unitUSD Amount, quantity int64) Amount {
	if c.Currency == "USD" {
		return LineTotal(unitUSD, quantity)
	}
	return c.Round(c.Amount(unitUSD).Mul(decimal.NewFromInt(quantity)))
}

// Format formats an amount of the currency.
func (c Converter) Format(a Amount) string { return Format(a, c.Currency) }

// Compute applies the rules of spec 2c in the currency to subtotal (a sum
// of the currency's line totals); absolute discount and services values
// are USD and converted:
//   - discount: percent → subtotal × p / 100 rounded; amount → the
//     converted value; either way capped at the subtotal;
//   - services: percent → (subtotal − discount) × p / 100 rounded; amount →
//     the converted value;
//   - grand total = subtotal − discount + services.
func (c Converter) Compute(subtotal Amount, discount, services Adjustment) Totals {
	t := Totals{Subtotal: c.Round(subtotal), Discount: Zero, Services: Zero}
	switch discount.Kind {
	case KindPercent:
		t.Discount = c.Round(t.Subtotal.Mul(discount.Value).Div(hundred))
	case KindAmount:
		t.Discount = c.Amount(discount.Value)
	}
	if t.Discount.GreaterThan(t.Subtotal) {
		t.Discount = t.Subtotal
	}
	net := t.Subtotal.Sub(t.Discount)
	switch services.Kind {
	case KindPercent:
		t.Services = c.Round(net.Mul(services.Value).Div(hundred))
	case KindAmount:
		t.Services = c.Amount(services.Value)
	}
	t.GrandTotal = net.Add(t.Services)
	return t
}
