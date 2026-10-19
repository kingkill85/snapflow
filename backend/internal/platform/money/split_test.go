package money

import (
	"testing"
)

func amounts(ss ...string) []Amount {
	out := make([]Amount, len(ss))
	for i, s := range ss {
		out[i] = MustParse(s)
	}
	return out
}

func TestAllocate(t *testing.T) {
	cases := []struct {
		name    string
		total   string
		weights []string
		want    []string
	}{
		{"even", "100.00", []string{"50", "50"}, []string{"50.00", "50.00"}},
		{"remainder to largest", "100.00", []string{"1", "1", "1"}, []string{"33.34", "33.33", "33.33"}},
		{"largest not first", "10.00", []string{"1", "2", "1"}, []string{"2.50", "5.00", "2.50"}},
		{"thirds of a cent", "0.01", []string{"1", "1", "1"}, []string{"0.01", "0.00", "0.00"}},
		{"remainder negative", "0.02", []string{"1", "1", "1"}, []string{"0.00", "0.01", "0.01"}},
		{"no weight", "5.00", []string{"0", "0"}, []string{"5.00", "0.00"}},
		{"one", "7.77", []string{"3"}, []string{"7.77"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Allocate(MustParse(c.total), amounts(c.weights...))
			sum := Zero
			for i, g := range got {
				sum = sum.Add(g)
				if !g.Equal(MustParse(c.want[i])) {
					t.Errorf("part %d = %s, want %s", i, g, c.want[i])
				}
			}
			if !sum.Equal(MustParse(c.total)) {
				t.Errorf("sum %s, want %s", sum, c.total)
			}
		})
	}
	// A remainder of -0.01 would be impossible with half-up per part only
	// when parts round down; the case above checks the sign is handled.
}

func TestSplit(t *testing.T) {
	cases := []struct {
		name               string
		subtotals          []string
		discount, services Adjustment
		wantSumsEqual      bool
		want               [][4]string // subtotal, discount, services, grand
	}{
		{
			name: "absolute amounts allocated", subtotals: []string{"300.00", "100.00"},
			discount: Adjustment{KindAmount, MustParse("40")}, services: Adjustment{KindAmount, MustParse("100")},
			wantSumsEqual: true,
			want:          [][4]string{{"300.00", "30.00", "75.00", "345.00"}, {"100.00", "10.00", "25.00", "115.00"}},
		},
		{
			name: "remainder cent to the largest", subtotals: []string{"100.00", "100.00", "100.01"},
			discount: Adjustment{KindAmount, MustParse("10")}, services: Adjustment{Kind: KindNone},
			wantSumsEqual: true,
			want:          [][4]string{{"100.00", "3.33", "0.00", "96.67"}, {"100.00", "3.33", "0.00", "96.67"}, {"100.01", "3.34", "0.00", "96.67"}},
		},
		{
			name: "percent on each subtotal", subtotals: []string{"200.00", "50.00"},
			discount: Adjustment{KindPercent, MustParse("10")}, services: Adjustment{KindPercent, MustParse("20")},
			wantSumsEqual: true,
			want:          [][4]string{{"200.00", "20.00", "36.00", "216.00"}, {"50.00", "5.00", "9.00", "54.00"}},
		},
		{
			name: "discount capped at the combined subtotal", subtotals: []string{"30.00", "10.00"},
			discount: Adjustment{KindAmount, MustParse("100")}, services: Adjustment{KindAmount, MustParse("8")},
			wantSumsEqual: true,
			want:          [][4]string{{"30.00", "30.00", "6.00", "6.00"}, {"10.00", "10.00", "2.00", "2.00"}},
		},
		{
			name: "empty document", subtotals: []string{"0.00", "80.00"},
			discount: Adjustment{KindAmount, MustParse("8")}, services: Adjustment{KindNone, Zero},
			wantSumsEqual: true,
			want:          [][4]string{{"0.00", "0.00", "0.00", "0.00"}, {"80.00", "8.00", "0.00", "72.00"}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			subs := amounts(c.subtotals...)
			got := Split(subs, c.discount, c.services)
			sum := Zero
			grand := Zero
			for i, g := range got {
				w := c.want[i]
				if !g.Subtotal.Equal(MustParse(w[0])) || !g.Discount.Equal(MustParse(w[1])) ||
					!g.Services.Equal(MustParse(w[2])) || !g.GrandTotal.Equal(MustParse(w[3])) {
					t.Errorf("doc %d = %s/%s/%s/%s, want %v", i, g.Subtotal, g.Discount, g.Services, g.GrandTotal, w)
				}
				sum = sum.Add(subs[i])
				grand = grand.Add(g.GrandTotal)
			}
			combined := Compute(sum, c.discount, c.services)
			if c.wantSumsEqual && !grand.Equal(combined.GrandTotal) {
				t.Errorf("documents sum to %s, combined grand total %s", grand, combined.GrandTotal)
			}
		})
	}
}
