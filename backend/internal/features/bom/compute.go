package bom

import (
	"cmp"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// acc accumulates the quantities of one variant.
type acc struct {
	item    store.VersionItem
	qty     LineQuantities
	total   int64
	direct  bool
	addOnOf []uuid.UUID
}

func newAcc(it store.VersionItem) *acc {
	return &acc{item: it, qty: LineQuantities{Plans: map[string]int64{}, Zones: map[string]int64{}, Unzoned: map[string]int64{}}, addOnOf: []uuid.UUID{}}
}

// counts adds up the placements (not existing, D185) and manual lines per
// variant: each placement is 1 × its variant, 1 × each required add-on of
// its snapshot and 1 × each chosen add-on; a manual catalog line adds its
// quantity of the variant and of each required add-on.
func (st *state) counts() (map[uuid.UUID]*acc, []BOMWarning) {
	lines := map[uuid.UUID]*acc{}
	warnings := []BOMWarning{}
	get := func(id uuid.UUID) *acc {
		a, ok := lines[id]
		if !ok {
			it, found := st.items[id]
			if !found {
				return nil
			}
			a = newAcc(it)
			lines[id] = a
		}
		return a
	}
	type origin struct {
		plan, zone string
		manual     bool
	}
	add := func(id uuid.UUID, n int64, o origin, direct bool, of *uuid.UUID) {
		a := get(id)
		if a == nil {
			return
		}
		a.total += n
		switch {
		case o.manual:
			a.qty.Manual += n
		default:
			a.qty.Plans[o.plan] += n
			if o.zone != "" {
				a.qty.Zones[o.zone] += n
			} else {
				a.qty.Unzoned[o.plan] += n
			}
		}
		if direct {
			a.direct = true
		}
		if of != nil && !slices.Contains(a.addOnOf, *of) {
			a.addOnOf = append(a.addOnOf, *of)
		}
	}
	addWithAddons := func(id uuid.UUID, chosen []uuid.UUID, n int64, o origin) {
		it := st.items[id]
		add(id, n, o, true, nil)
		for _, r := range it.RequiredAddonIds {
			add(r, n, o, false, &id)
		}
		for _, c := range chosen {
			if !slices.Contains(it.RequiredAddonIds, c) {
				add(c, n, o, false, &id)
			}
		}
	}
	for _, p := range st.plans {
		for _, pl := range p.Placements {
			if pl.Existing {
				continue
			}
			if pl.VariantID == nil {
				warnings = append(warnings, BOMWarning{Code: "placement_without_snapshot", PlanID: p.ID, PlacementID: pl.ID})
				continue
			}
			if _, ok := st.items[*pl.VariantID]; !ok {
				warnings = append(warnings, BOMWarning{Code: "placement_without_snapshot", PlanID: p.ID, PlacementID: pl.ID})
				continue
			}
			o := origin{plan: p.ID.String()}
			if pl.ZoneID != nil {
				o.zone = pl.ZoneID.String()
			}
			addWithAddons(*pl.VariantID, pl.AddonVariantIDs, 1, o)
		}
	}
	for _, m := range st.manual {
		if m.VariantID == nil {
			continue
		}
		if _, ok := st.items[*m.VariantID]; ok {
			addWithAddons(*m.VariantID, nil, int64(m.Quantity), origin{manual: true})
		}
	}
	return lines, warnings
}

// status is the live catalog status of a snapshot.
func (st *state) status(it store.VersionItem) LineStatus {
	f, ok := st.catalog[it.VariantID]
	if !ok {
		return LineStatus{Deleted: true}
	}
	return LineStatus{Available: f.Available, Inactive: !f.Available, Outdated: len(changedFields(it, f)) > 0}
}

// changedFields lists what differs between a snapshot and the catalog.
func changedFields(it store.VersionItem, f products.BOMVariant) []string {
	var out []string
	if !money.MustParse(it.UnitPrice).Equal(money.MustParse(f.Price)) {
		out = append(out, "unitPrice")
	}
	if !sameText(it.ProductName, f.ProductName) {
		out = append(out, "productName")
	}
	if !sameText(it.VariantName, f.VariantName) {
		out = append(out, "variantName")
	}
	if it.ModelNumber != f.ModelNumber {
		out = append(out, "modelNumber")
	}
	if deref(it.Sku) != deref(f.SKU) {
		out = append(out, "sku")
	}
	if !sameID(it.ImageFileID, f.ImageFileID) {
		out = append(out, "image")
	}
	if !sameIDs(it.RequiredAddonIds, f.RequiredAddonIDs) {
		out = append(out, "requiredAddons")
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func sameID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// order settles one position (and one shown snapshot) per product type and
// per category, so a catalog reorder between two snapshots never splits a
// group: the live catalog position when a used variant of it still exists,
// else the newest snapshot's (D244).
type order struct {
	types, cats map[uuid.UUID]int32
	// typeItem and catItem are the newest snapshot of each, whose names and
	// colour the group headers show.
	typeItem, catItem map[uuid.UUID]store.VersionItem
}

func (st *state) order() order {
	o := order{types: map[uuid.UUID]int32{}, cats: map[uuid.UUID]int32{}, typeItem: map[uuid.UUID]store.VersionItem{}, catItem: map[uuid.UUID]store.VersionItem{}}
	newer := func(a, b store.VersionItem) bool {
		return a.UpdatedAt.After(b.UpdatedAt) || (a.UpdatedAt.Equal(b.UpdatedAt) && a.VariantID.String() > b.VariantID.String())
	}
	for _, it := range st.items {
		if prev, ok := o.typeItem[it.ProductTypeID]; !ok || newer(it, prev) {
			o.typeItem[it.ProductTypeID] = it
			o.types[it.ProductTypeID] = it.ProductTypePosition
		}
		if prev, ok := o.catItem[it.CategoryID]; !ok || newer(it, prev) {
			o.catItem[it.CategoryID] = it
			o.cats[it.CategoryID] = it.CategoryPosition
		}
	}
	for _, f := range st.catalog {
		if _, ok := o.types[f.ProductType.ID]; ok {
			o.types[f.ProductType.ID] = f.ProductType.SortOrder
		}
		if _, ok := o.cats[f.Category.ID]; ok {
			o.cats[f.Category.ID] = f.Category.SortOrder
		}
	}
	return o
}

// less is the BOM order (D82): product type catalog order, category
// catalog order (settled per id), model number, variant name (snapshot
// values).
func (o order) less(a, b store.VersionItem) int {
	return cmp.Or(
		cmp.Compare(o.types[a.ProductTypeID], o.types[b.ProductTypeID]),
		strings.Compare(a.ProductTypeID.String(), b.ProductTypeID.String()),
		cmp.Compare(o.cats[a.CategoryID], o.cats[b.CategoryID]),
		strings.Compare(a.CategoryID.String(), b.CategoryID.String()),
		strings.Compare(strings.ToLower(a.ModelNumber), strings.ToLower(b.ModelNumber)),
		strings.Compare(strings.ToLower(a.VariantName["en"]), strings.ToLower(b.VariantName["en"])),
		strings.Compare(a.VariantID.String(), b.VariantID.String()),
	)
}

// currency is the conversion of a version's amounts (nil for USD): the
// customer-facing amounts in the project currency (D267).
type currency struct {
	money.Converter
}

func (st *state) currency() *currency { return currencyOf(st.ref) }

// currencyOf is the conversion of a version's amounts (nil for USD).
func currencyOf(ref projects.VersionRef) *currency {
	if ref.Currency == "" || ref.Currency == "USD" {
		return nil
	}
	return &currency{money.Converter{Currency: ref.Currency, Rate: money.MustParse(ref.ExchangeRate)}}
}

// line is a line's unit price and total in the project currency (nil for
// USD) and the converted total (zero for USD).
func (c *currency) line(unitUSD money.Amount, quantity int64) (*NullableConvertedLine, money.Amount) {
	if c == nil {
		return nil, money.Zero
	}
	total := c.LineTotal(unitUSD, quantity)
	return &NullableConvertedLine{ConvertedLine: ConvertedLine{UnitPrice: c.Format(c.Amount(unitUSD)), Total: c.Format(total)}}, total
}

// format formats an amount of the currency (nil for USD).
func (c *currency) format(a money.Amount) *string {
	if c == nil {
		return nil
	}
	s := c.Format(a)
	return &s
}

// bom computes the BOM of the state.
func (st *state) bom() BOM {
	cur := st.currency()
	accs, warnings := st.counts()
	ordered := make([]*acc, 0, len(accs))
	for _, a := range accs {
		ordered = append(ordered, a)
	}
	ord := st.order()
	slices.SortFunc(ordered, func(a, b *acc) int { return ord.less(a.item, b.item) })

	out := BOM{Lines: []BOMLine{}, Groups: []BOMGroup{}, Warnings: warnings, Plans: []BOMPlanRef{}, ManualLines: st.manualLines()}
	for _, p := range st.plans {
		ref := BOMPlanRef{ID: p.ID, Name: p.Name, Zones: []BOMZoneRef{}}
		for _, z := range p.Zones {
			ref.Zones = append(ref.Zones, BOMZoneRef{ID: z.ID, Name: z.Name})
		}
		out.Plans = append(out.Plans, ref)
	}
	// USD sums, and the same sums of the converted line totals.
	subtotal, convSubtotal := money.Zero, money.Zero
	var group *BOMGroup
	var groupSum, catSum, convGroupSum, convCatSum money.Amount
	closeCat := func() {
		if group != nil && len(group.Categories) > 0 {
			c := &group.Categories[len(group.Categories)-1]
			c.Subtotal, c.Converted = money.USD(catSum), cur.format(convCatSum)
		}
	}
	closeGroup := func() {
		closeCat()
		if group != nil {
			group.Subtotal, group.Converted = money.USD(groupSum), cur.format(convGroupSum)
			out.Groups = append(out.Groups, *group)
		}
	}
	for _, a := range ordered {
		it := a.item
		unit := money.MustParse(it.UnitPrice)
		total := money.LineTotal(unit, a.total)
		subtotal = subtotal.Add(total)
		kind := KindCatalog
		if !a.direct {
			kind = KindAddOn
		}
		variantID, productID := it.VariantID, it.ProductID
		snap := snapshotOf(it)
		status := st.status(it)
		line := BOMLine{
			Key: it.VariantID.String(), Kind: kind, VariantID: &variantID, ProductID: &productID, Snapshot: &NullableItemSnapshot{ItemSnapshot: snap},
			UnitPrice: money.USD(unit), Quantity: a.total, Quantities: a.qty, Total: money.USD(total),
			Status: &NullableLineStatus{LineStatus: status}, AddOnOf: a.addOnOf,
		}
		var conv money.Amount
		line.Converted, conv = cur.line(unit, a.total)
		convSubtotal = convSubtotal.Add(conv)
		out.Lines = append(out.Lines, line)

		if group == nil || group.ProductType.ID != it.ProductTypeID {
			closeGroup()
			pt := snapshotOf(ord.typeItem[it.ProductTypeID]).ProductType
			group = &BOMGroup{Kind: "productType", ProductType: &NullableSnapshotProductType{SnapshotProductType: pt}, Categories: []BOMCategoryGroup{}, Lines: []string{}}
			groupSum, convGroupSum = money.Zero, money.Zero
		}
		if n := len(group.Categories); n == 0 || group.Categories[n-1].Category.ID != it.CategoryID {
			closeCat()
			group.Categories = append(group.Categories, BOMCategoryGroup{Category: snapshotOf(ord.catItem[it.CategoryID]).Category, Lines: []string{}})
			catSum, convCatSum = money.Zero, money.Zero
		}
		c := &group.Categories[len(group.Categories)-1]
		c.Lines = append(c.Lines, line.Key)
		groupSum, catSum = groupSum.Add(total), catSum.Add(total)
		convGroupSum, convCatSum = convGroupSum.Add(conv), convCatSum.Add(conv)
	}
	closeGroup()

	// Free-text lines last, in their own group, in manual-line order.
	var free *BOMGroup
	freeSum, convFreeSum := money.Zero, money.Zero
	for _, m := range st.manual {
		if m.VariantID != nil {
			continue
		}
		unit := money.MustParse(deref(m.UnitPrice))
		total := money.LineTotal(unit, int64(m.Quantity))
		subtotal = subtotal.Add(total)
		freeSum = freeSum.Add(total)
		line := BOMLine{
			Key: m.ID.String(), Kind: KindFreeText, Name: deref(m.Name), UnitPrice: money.USD(unit),
			Quantity: int64(m.Quantity), Total: money.USD(total), AddOnOf: []uuid.UUID{},
			Quantities: LineQuantities{Plans: map[string]int64{}, Zones: map[string]int64{}, Unzoned: map[string]int64{}, Manual: int64(m.Quantity)},
		}
		var conv money.Amount
		line.Converted, conv = cur.line(unit, int64(m.Quantity))
		convSubtotal, convFreeSum = convSubtotal.Add(conv), convFreeSum.Add(conv)
		out.Lines = append(out.Lines, line)
		if free == nil {
			free = &BOMGroup{Kind: "freeText", Categories: []BOMCategoryGroup{}, Lines: []string{}}
		}
		free.Lines = append(free.Lines, line.Key)
	}
	if free != nil {
		free.Subtotal, free.Converted = money.USD(freeSum), cur.format(convFreeSum)
		out.Groups = append(out.Groups, *free)
	}

	out.Pricing = st.pricingOut()
	out.Totals = st.totals(subtotal, convSubtotal, out.Pricing)
	return out
}

// grandTotal is the USD grand total of the state.
func (st *state) grandTotal() money.Amount {
	accs, _ := st.counts()
	subtotal := money.Zero
	for _, a := range accs {
		subtotal = subtotal.Add(money.LineTotal(money.MustParse(a.item.UnitPrice), a.total))
	}
	for _, m := range st.manual {
		if m.VariantID == nil {
			subtotal = subtotal.Add(money.LineTotal(money.MustParse(deref(m.UnitPrice)), int64(m.Quantity)))
		}
	}
	p := st.pricingOut()
	return computeTotals(subtotal, p).GrandTotal
}

func computeTotals(subtotal money.Amount, p Pricing) money.Totals {
	return computeIn(money.USDConverter, subtotal, p)
}

func computeIn(c money.Converter, subtotal money.Amount, p Pricing) money.Totals {
	discount, services := adjustments(p)
	return c.Compute(subtotal, discount, services)
}

func adjustments(p Pricing) (discount, services money.Adjustment) {
	return money.Adjustment{Kind: money.Kind(p.DiscountKind), Value: money.MustParse(p.DiscountValue)},
		money.Adjustment{Kind: money.Kind(p.ServicesKind), Value: money.MustParse(p.ServicesValue)}
}

// totals are the version's totals: USD from the USD subtotal, and in the
// project currency from the sum of the converted line totals (D267).
func (st *state) totals(subtotal, convSubtotal money.Amount, p Pricing) BOMTotals {
	t := computeTotals(subtotal, p)
	out := BOMTotals{
		BOMAmounts: amountsOf(money.USDConverter, t),
		Currency:   "USD", Rate: "1",
	}
	if st.ref.Currency != "" {
		out.Currency, out.Rate = st.ref.Currency, money.MustParse(st.ref.ExchangeRate).String()
	}
	if cur := st.currency(); cur != nil {
		out.Converted = &NullableBOMAmounts{BOMAmounts: amountsOf(cur.Converter, computeIn(cur.Converter, convSubtotal, p))}
	}
	return out
}

func amountsOf(c money.Converter, t money.Totals) BOMAmounts {
	return BOMAmounts{Subtotal: c.Format(t.Subtotal), Discount: c.Format(t.Discount), Services: c.Format(t.Services), GrandTotal: c.Format(t.GrandTotal)}
}
