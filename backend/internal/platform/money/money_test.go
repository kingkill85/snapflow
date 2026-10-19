package money_test

import (
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

var m = money.MustParse

func TestLineTotal(t *testing.T) {
	for _, tc := range []struct {
		price string
		qty   int64
		want  string
	}{
		{"10.00", 3, "30.00"},
		{"0.005", 1, "0.01"},    // half up
		{"0.004", 1, "0.00"},    // below half
		{"0.125", 1, "0.13"},    // half up, not to even
		{"0.135", 1, "0.14"},    // half up
		{"1.005", 3, "3.02"},    // exact product 3.015 first, then rounded
		{"33.333", 3, "100.00"}, // 99.999
		{"19.99", 100000, "1999000.00"},
		{"0", 5, "0.00"},
	} {
		if got := money.USD(money.LineTotal(m(tc.price), tc.qty)); got != tc.want {
			t.Errorf("%s × %d = %s, want %s", tc.price, tc.qty, got, tc.want)
		}
	}
}

func TestCompute(t *testing.T) {
	none := money.Adjustment{Kind: money.KindNone}
	pct := func(v string) money.Adjustment { return money.Adjustment{Kind: money.KindPercent, Value: m(v)} }
	amt := func(v string) money.Adjustment { return money.Adjustment{Kind: money.KindAmount, Value: m(v)} }
	for _, tc := range []struct {
		name                                  string
		subtotal                              string
		discount, services                    money.Adjustment
		wantDiscount, wantServices, wantGrand string
	}{
		{"nothing", "100.00", none, none, "0.00", "0.00", "100.00"},
		{"percent discount", "100.00", pct("10"), none, "10.00", "0.00", "90.00"},
		{"percent discount rounds half up", "10.05", pct("10"), none, "1.01", "0.00", "9.04"},      // 1.005
		{"percent discount with decimals", "199.99", pct("12.5"), none, "25.00", "0.00", "174.99"}, // 24.99875
		{"100 % discount", "50.00", pct("100"), none, "50.00", "0.00", "0.00"},
		{"amount discount", "100.00", amt("15.50"), none, "15.50", "0.00", "84.50"},
		{"amount discount capped at subtotal", "100.00", amt("150"), none, "100.00", "0.00", "0.00"},
		{"amount discount on empty BOM", "0.00", amt("10"), none, "0.00", "0.00", "0.00"},
		{"percent services on subtotal minus discount", "100.00", pct("10"), pct("20"), "10.00", "18.00", "108.00"},
		{"percent services rounds half up", "10.05", none, pct("10"), "0.00", "1.01", "11.06"},
		{"amount services", "100.00", amt("20"), amt("250"), "20.00", "250.00", "330.00"},
		{"amount services after capped discount", "100.00", amt("500"), amt("250"), "100.00", "250.00", "250.00"},
		{"percent services after full discount", "100.00", pct("100"), pct("15"), "100.00", "0.00", "0.00"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := money.Compute(m(tc.subtotal), tc.discount, tc.services)
			if money.USD(got.Discount) != tc.wantDiscount || money.USD(got.Services) != tc.wantServices || money.USD(got.GrandTotal) != tc.wantGrand {
				t.Errorf("got discount %s services %s grand %s, want %s %s %s", money.USD(got.Discount),
					money.USD(got.Services), money.USD(got.GrandTotal), tc.wantDiscount, tc.wantServices, tc.wantGrand)
			}
		})
	}
}

func TestConvert(t *testing.T) {
	for _, tc := range []struct {
		usd, rate, currency, want string
	}{
		{"100.00", "1", "USD", "100.00"},
		{"10.00", "0.92", "EUR", "9.20"},
		{"0.01", "0.5", "EUR", "0.01"},        // 0.005 half up
		{"19.99", "0.923456", "EUR", "18.46"}, // 18.459885…
		{"19.99", "149.5", "JPY", "2989"},     // 2988.505 → 0 decimals
		{"10.01", "149.95", "JPY", "1501"},    // 1500.9995
		{"1.00", "1350.5", "KRW", "1351"},     // half up at 0 decimals
		{"100.00", "0.376", "BHD", "37.600"},  // 3 decimals
		{"1.23", "0.3071", "KWD", "0.378"},    // 0.377733
		{"1.25", "0.3846", "OMR", "0.481"},    // 0.48075 → half up at 3 decimals
	} {
		got := money.Format(money.Convert(m(tc.usd), m(tc.rate), tc.currency), tc.currency)
		if got != tc.want {
			t.Errorf("%s USD × %s %s = %s, want %s", tc.usd, tc.rate, tc.currency, got, tc.want)
		}
	}
	for cur, want := range map[string]int32{"USD": 2, "EUR": 2, "CHF": 2, "JPY": 0, "KRW": 0, "BHD": 3, "KWD": 3, "OMR": 3} {
		if got := money.MinorUnits(cur); got != want {
			t.Errorf("MinorUnits(%s) = %d, want %d", cur, got, want)
		}
	}
}

func TestParse(t *testing.T) {
	for _, s := range []string{"", "1e3", " 1", "abc", "1,5"} {
		if _, err := money.Parse(s); err == nil {
			t.Errorf("Parse(%q) accepted", s)
		}
	}
	if d, err := money.Parse("12.50"); err != nil || money.USD(d) != "12.50" {
		t.Errorf("Parse(12.50) = %v, %v", d, err)
	}
}
