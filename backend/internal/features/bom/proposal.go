package bom

// What proposals (step 2d) use of the BOM: the BOM of a version split into
// one part per product type with the split totals (money.Split), and the
// snapshot facts of every variant the version uses (for plan images).

import (
	"context"
	"slices"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// Part is the BOM of one product type of a version: its lines and its one
// group, with totals from money.Split.
type Part struct {
	ProductType SnapshotProductType
	BOM         BOM
}

// SplitByProductType divides b into one part per product type in typeIDs (in
// BOM order). Free-text lines belong to no part. Percent discount and
// services apply to each part's own subtotal; absolute amounts are
// allocated by the part's share of the whole goods subtotal (every group of
// b, free text included), so the parts of all product types add up to the
// combined BOM when it has no free-text lines (money.Split). The amounts in
// the project currency are split the same way from the groups' converted
// subtotals (D267). A type without
// lines in b is bom.product_type_not_in_bom.
func SplitByProductType(b BOM, typeIDs []uuid.UUID) ([]Part, error) {
	var errs []apperr.FieldError
	for i, id := range typeIDs {
		if !slices.ContainsFunc(b.Groups, func(g BOMGroup) bool { return g.ProductType != nil && g.ProductType.ID == id }) {
			errs = append(errs, apperr.Field("body.productTypeIds["+strconv.Itoa(i)+"]", "proposal.product_type_not_in_bom",
				"the version has no lines of this product type"))
		}
	}
	if len(errs) > 0 {
		return nil, apperr.Validation(errs...)
	}
	weights := make([]money.Amount, len(b.Groups))
	convWeights := make([]money.Amount, len(b.Groups))
	for i, g := range b.Groups {
		weights[i] = money.MustParse(g.Subtotal)
		if g.Converted != nil {
			convWeights[i] = money.MustParse(*g.Converted)
		}
	}
	discount, services := adjustments(b.Pricing)
	totals := money.Split(weights, discount, services)
	cur := currencyOf(projects.VersionRef{Currency: b.Totals.Currency, ExchangeRate: b.Totals.Rate})
	var convTotals []money.Totals
	if cur != nil {
		convTotals = cur.Split(convWeights, discount, services)
	}
	lines := make(map[string]BOMLine, len(b.Lines))
	for _, l := range b.Lines {
		lines[l.Key] = l
	}
	var out []Part
	for gi, g := range b.Groups {
		if g.ProductType == nil || !slices.Contains(typeIDs, g.ProductType.ID) {
			continue
		}
		part := b
		part.Groups = []BOMGroup{g}
		part.Lines = []BOMLine{}
		for _, c := range g.Categories {
			for _, k := range c.Lines {
				part.Lines = append(part.Lines, lines[k])
			}
		}
		// The part keeps the manual lines of its lines (their notes print).
		part.ManualLines = []ManualLine{}
		for _, m := range b.ManualLines {
			if m.VariantID != nil && slices.ContainsFunc(part.Lines, func(l BOMLine) bool { return l.Key == m.VariantID.String() }) {
				part.ManualLines = append(part.ManualLines, m)
			}
		}
		part.Warnings = []BOMWarning{}
		part.Totals = BOMTotals{BOMAmounts: amountsOf(money.USDConverter, totals[gi]), Currency: b.Totals.Currency, Rate: b.Totals.Rate,
			RateDate: b.Totals.RateDate, RateSource: b.Totals.RateSource}
		if cur != nil {
			part.Totals.Converted = &NullableBOMAmounts{BOMAmounts: amountsOf(cur.Converter, convTotals[gi])}
		}
		out = append(out, Part{ProductType: g.ProductType.SnapshotProductType, BOM: part})
	}
	return out, nil
}

// VariantSnapshot are the frozen facts of a variant a version uses.
type VariantSnapshot struct {
	VariantID   uuid.UUID
	ProductName i18n.Text
	VariantName i18n.Text
	ProductType SnapshotProductType
	ImageFileID *uuid.UUID
}

// Snapshots returns the snapshot of every variant of a version, by variant
// id (also variants only placed as existing devices, D247). Needs
// projects.read.
func (s *Service) Snapshots(ctx context.Context, versionID uuid.UUID) (map[uuid.UUID]VariantSnapshot, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var rows []store.VersionItem
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListItems(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	l, err := s.liveCatalog(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]VariantSnapshot, len(rows))
	for _, r := range rows {
		snap := l.snapshotOf(r)
		out[r.VariantID] = VariantSnapshot{
			VariantID: r.VariantID, ProductName: r.ProductName, VariantName: r.VariantName,
			ProductType: snap.ProductType, ImageFileID: r.ImageFileID,
		}
	}
	return out, nil
}
