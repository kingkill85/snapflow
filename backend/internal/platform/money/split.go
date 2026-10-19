package money

// Allocate splits total into len(weights) parts in proportion to weights:
// each part is total × weight / Σweights rounded half up to cents, and the
// rounding remainder goes to the part with the largest weight (the first of
// equal ones), so the parts always add up to total. Without any weight the
// whole total goes to the first part.
func Allocate(total Amount, weights []Amount) []Amount {
	out := make([]Amount, len(weights))
	if len(weights) == 0 {
		return out
	}
	sum, largest := Zero, 0
	for i, w := range weights {
		sum = sum.Add(w)
		if w.GreaterThan(weights[largest]) {
			largest = i
		}
	}
	allocated := Zero
	for i, w := range weights {
		out[i] = Zero
		if sum.IsPositive() {
			out[i] = RoundUSD(total.Mul(w).Div(sum))
		}
		allocated = allocated.Add(out[i])
	}
	out[largest] = out[largest].Add(total.Sub(allocated))
	return out
}

// Split computes the totals of documents that divide one version's goods
// (e.g. one proposal per product type, spec 2d). subtotals are the
// documents' goods subtotals:
//   - a percent discount or services value applies to each document's own
//     subtotal (services to subtotal − discount), rounded per document;
//   - an absolute amount is the combined one (Compute over the sum of the
//     subtotals, so the discount is capped at the combined subtotal) and is
//     allocated by each document's share of the summed subtotals (Allocate),
//     so the documents' amounts add up to the combined amount.
//
// Percent amounts are rounded per document and may therefore differ from
// the combined percent amount by a cent per document.
func Split(subtotals []Amount, discount, services Adjustment) []Totals {
	sum := Zero
	for _, s := range subtotals {
		sum = sum.Add(RoundUSD(s))
	}
	combined := Compute(sum, discount, services)
	weights := make([]Amount, len(subtotals))
	for i, s := range subtotals {
		weights[i] = RoundUSD(s)
	}
	discounts := Allocate(combined.Discount, weights)
	servicesAmounts := Allocate(combined.Services, weights)
	out := make([]Totals, len(subtotals))
	for i, sub := range weights {
		t := Totals{Subtotal: sub, Discount: Zero, Services: Zero}
		switch discount.Kind {
		case KindPercent:
			t.Discount = RoundUSD(sub.Mul(discount.Value).Div(hundred))
		case KindAmount:
			t.Discount = discounts[i]
		}
		if t.Discount.GreaterThan(sub) {
			t.Discount = sub
		}
		net := sub.Sub(t.Discount)
		switch services.Kind {
		case KindPercent:
			t.Services = RoundUSD(net.Mul(services.Value).Div(hundred))
		case KindAmount:
			t.Services = servicesAmounts[i]
		}
		t.GrandTotal = net.Add(t.Services)
		out[i] = t
	}
	return out
}
