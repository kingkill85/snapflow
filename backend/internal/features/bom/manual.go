package bom

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

const (
	maxNameLength = 200
	maxNoteLength = 500
	maxQuantity   = 100000
	// MaxManualLines bounds the manual lines of a version.
	MaxManualLines = 1000
)

func (st *state) manualLines() []ManualLine {
	out := make([]ManualLine, 0, len(st.manual))
	cur := st.currency()
	for _, m := range st.manual {
		out = append(out, manualLineOf(m, st.items, cur))
	}
	return out
}

// manualLineOf is a manual line with its amounts: unit price and total in
// USD and, for another project currency (cur), converted like BOM lines.
func manualLineOf(m store.VersionManualLine, items map[uuid.UUID]store.VersionItem, cur *currency) ManualLine {
	l := ManualLine{ID: m.ID, Kind: KindFreeText, VariantID: m.VariantID, Name: deref(m.Name), Quantity: m.Quantity, Note: m.Note, UpdatedAt: m.UpdatedAt}
	var unit money.Amount
	if m.VariantID != nil {
		l.Kind = KindCatalog
		it, ok := items[*m.VariantID]
		if !ok {
			return l // no snapshot (cannot happen: the line's insert takes one)
		}
		l.Snapshot = &NullableItemSnapshot{ItemSnapshot: snapshotOf(it)}
		unit = money.MustParse(it.UnitPrice)
	} else {
		unit = money.MustParse(deref(m.UnitPrice))
	}
	total := money.LineTotal(unit, int64(m.Quantity))
	l.UnitPrice, l.Total = money.USD(unit), money.USD(total)
	l.Converted, _ = cur.line(unit, int64(m.Quantity))
	return l
}

type manualValues struct {
	variantID *uuid.UUID
	name      *string
	unitPrice *string
	quantity  int32
	note      string
}

func validManual(in ManualLineInput) (manualValues, error) {
	var errs []apperr.FieldError
	v := manualValues{quantity: in.Quantity}
	name := strings.TrimSpace(in.Name)
	if in.VariantID != nil {
		if name != "" || strings.TrimSpace(in.UnitPrice) != "" {
			errs = append(errs, apperr.Field("body", "bom.line_kind", "send either variantId or name and unitPrice"))
		}
		v.variantID = in.VariantID
	} else {
		switch {
		case name == "":
			errs = append(errs, apperr.Field("body.name", "validation.required", "a name or a variant is required"))
		case utf8.RuneCountInString(name) > maxNameLength:
			errs = append(errs, apperr.Field("body.name", "validation.too_long", "too long").With("max", maxNameLength))
		case strings.IndexFunc(name, unicode.IsControl) >= 0:
			errs = append(errs, apperr.Field("body.name", "validation.invalid", "no control characters"))
		}
		v.name = &name
		d, err := money.Parse(strings.TrimSpace(in.UnitPrice))
		if err != nil || d.IsNegative() || !d.Equal(d.Round(2)) || d.GreaterThan(maxAmount) {
			errs = append(errs, apperr.Field("body.unitPrice", "bom.unit_price_invalid", "a USD amount >= 0 with at most 2 decimals"))
		} else {
			p := money.USD(d)
			v.unitPrice = &p
		}
	}
	if in.Quantity < 1 || in.Quantity > maxQuantity {
		errs = append(errs, apperr.Field("body.quantity", "bom.quantity_range", "1-100000").With("min", 1).With("max", maxQuantity))
	}
	v.note = strings.TrimSpace(in.Note)
	if utf8.RuneCountInString(v.note) > maxNoteLength {
		errs = append(errs, apperr.Field("body.note", "validation.too_long", "too long").With("max", maxNoteLength))
	}
	if len(errs) > 0 {
		return v, apperr.Validation(errs...)
	}
	return v, nil
}

// lineFacts are the catalog facts of a catalog line's variant, read before
// the transaction (D243).
type lineFacts struct {
	// live is the variant as the catalog has it now (nil when deleted).
	live *products.BOMVariant
	// snapshots are the snapshots to take (the variant and its required
	// add-ons, those the version has none of).
	snapshots map[uuid.UUID]products.BOMVariant
}

func (s *Service) prepareLine(ctx context.Context, versionID uuid.UUID, v manualValues) (lineFacts, error) {
	var out lineFacts
	if v.variantID == nil {
		return out, nil
	}
	live, err := s.products.BOMVariants(ctx, []uuid.UUID{*v.variantID})
	if err != nil {
		return out, err
	}
	if f, ok := live[*v.variantID]; ok {
		out.live = &f
	}
	out.snapshots, err = s.snapshotFacts(ctx, versionID, []uuid.UUID{*v.variantID})
	return out, err
}

// catalogLine makes sure a catalog line's variant has a snapshot (taken now
// at its first appearance); bom.variant_not_found when the variant neither
// exists nor has a snapshot. A variant newly put on a line (check) must be
// available (bom.variant_unavailable) and of a product type of the project
// (bom.product_type_not_in_project); lines that keep their variant stay as
// they are.
func (s *Service) catalogLine(ctx context.Context, q *store.Queries, ref projects.VersionRef, v manualValues, facts lineFacts, check bool) error {
	if v.variantID == nil {
		return nil
	}
	if check && facts.live != nil {
		if !facts.live.Available {
			return apperr.Invalid("body.variantId", "bom.variant_unavailable", "the variant is not available")
		}
		if !slices.Contains(ref.ProductTypeIDs, facts.live.ProductType.ID) {
			return apperr.Invalid("body.variantId", "bom.product_type_not_in_project", "the variant's product type is not part of the project")
		}
	}
	if err := insertSnapshots(ctx, q, ref, facts.snapshots); err != nil {
		return err
	}
	ids, err := q.ItemVariantIDs(ctx, ref.ID)
	if err != nil {
		return err
	}
	if slices.Contains(ids, *v.variantID) && (!check || facts.live != nil) {
		return nil
	}
	return apperr.Invalid("body.variantId", "bom.variant_not_found", "no such variant")
}

// CreateManualLine adds a manual line at the end.
func (s *Service) CreateManualLine(ctx context.Context, versionID uuid.UUID, in ManualLineInput) (ManualLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ManualLine{}, err
	}
	v, err := validManual(in)
	if err != nil {
		return ManualLine{}, err
	}
	facts, err := s.prepareLine(ctx, versionID, v)
	if err != nil {
		return ManualLine{}, err
	}
	var out ManualLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		lines, err := q.ListManualLines(ctx, versionID)
		if err != nil {
			return err
		}
		if len(lines) >= MaxManualLines {
			return apperr.Conflict("bom.too_many_lines", "too many manual lines").With("max", MaxManualLines)
		}
		if err := s.catalogLine(ctx, q, ref, v, facts, true); err != nil {
			return err
		}
		row, err := q.InsertManualLine(ctx, store.InsertManualLineParams{
			TenantID: ref.TenantID, VersionID: versionID, VariantID: v.variantID, Name: v.name, UnitPrice: v.unitPrice,
			Quantity: v.quantity, Note: v.note,
		})
		if err != nil {
			return err
		}
		out, err = s.lineOut(ctx, q, ref, row)
		return err
	})
	return out, err
}

func (s *Service) lineOut(ctx context.Context, q *store.Queries, ref projects.VersionRef, row store.VersionManualLine) (ManualLine, error) {
	items := map[uuid.UUID]store.VersionItem{}
	if row.VariantID != nil {
		rows, err := q.ListItems(ctx, row.VersionID)
		if err != nil {
			return ManualLine{}, err
		}
		for _, r := range rows {
			items[r.VariantID] = r
		}
	}
	return manualLineOf(row, items, currencyOf(ref)), nil
}

// lockLine locks a manual line of the version for a change.
func (s *Service) lockLine(ctx context.Context, tx pgx.Tx, q *store.Queries, versionID, id uuid.UUID) (projects.VersionRef, store.VersionManualLine, error) {
	ref, err := s.projects.WriteVersion(ctx, tx, versionID, false)
	if err != nil {
		return ref, store.VersionManualLine{}, err
	}
	row, err := q.LockManualLine(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.VersionID != versionID) {
		return ref, row, errLineNotFound()
	}
	return ref, row, err
}

// UpdateManualLine changes a manual line; bom.line_stale if it changed since
// in.ExpectedUpdatedAt.
func (s *Service) UpdateManualLine(ctx context.Context, versionID, id uuid.UUID, in ManualLineUpdate) (ManualLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ManualLine{}, err
	}
	v, err := validManual(in.ManualLineInput)
	if err != nil {
		return ManualLine{}, err
	}
	facts, err := s.prepareLine(ctx, versionID, v)
	if err != nil {
		return ManualLine{}, err
	}
	var out ManualLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, row, err := s.lockLine(ctx, tx, q, versionID, id)
		if err != nil {
			return err
		}
		if !row.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
			return apperr.Conflict("bom.line_stale", "the line was changed by someone else")
		}
		if err := s.catalogLine(ctx, q, ref, v, facts, !sameID(row.VariantID, v.variantID)); err != nil {
			return err
		}
		row, err = q.UpdateManualLine(ctx, store.UpdateManualLineParams{
			ID: id, VariantID: v.variantID, Name: v.name, UnitPrice: v.unitPrice, Quantity: v.quantity, Note: v.note,
		})
		if err != nil {
			return err
		}
		out, err = s.lineOut(ctx, q, ref, row)
		return err
	})
	return out, err
}

// DeleteManualLine removes a manual line.
func (s *Service) DeleteManualLine(ctx context.Context, versionID, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, _, err := s.lockLine(ctx, tx, q, versionID, id); err != nil {
			return err
		}
		_, err := q.DeleteManualLine(ctx, id)
		return err
	})
}

// ListManualLines returns the manual lines of a version in order.
func (s *Service) ListManualLines(ctx context.Context, versionID uuid.UUID) ([]ManualLine, error) {
	b, err := s.Get(ctx, versionID)
	return b.ManualLines, err
}

// ReorderManualLines sets the order; ids must list every manual line of
// the version exactly once (bom.order_mismatch).
func (s *Service) ReorderManualLines(ctx context.Context, versionID uuid.UUID, ids []uuid.UUID) ([]ManualLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return nil, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		lines, err := q.ListManualLines(ctx, versionID)
		if err != nil {
			return err
		}
		existing := make([]uuid.UUID, len(lines))
		for i, l := range lines {
			existing[i] = l.ID
		}
		if !sameIDs(ids, existing) || len(ids) != len(existing) {
			return apperr.New(http.StatusUnprocessableEntity, "bom.order_mismatch", "ids must list every manual line of the version exactly once")
		}
		seen := map[uuid.UUID]bool{}
		for i, id := range ids {
			if seen[id] {
				return apperr.New(http.StatusUnprocessableEntity, "bom.order_mismatch", "ids must list every manual line of the version exactly once")
			}
			seen[id] = true
			if err := q.SetManualLinePosition(ctx, store.SetManualLinePositionParams{ID: id, Position: int32(i + 1)}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.ListManualLines(ctx, versionID)
}

func errLineNotFound() *apperr.Error { return apperr.NotFound("bom.line_not_found") }
