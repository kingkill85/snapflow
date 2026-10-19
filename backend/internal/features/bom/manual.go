package bom

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
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
	for _, m := range st.manual {
		out = append(out, manualLineOf(m, st.items))
	}
	return out
}

func manualLineOf(m store.VersionManualLine, items map[uuid.UUID]store.VersionItem) ManualLine {
	l := ManualLine{ID: m.ID, Kind: KindFreeText, VariantID: m.VariantID, Name: deref(m.Name), Quantity: m.Quantity, Note: m.Note, UpdatedAt: m.UpdatedAt}
	if m.VariantID != nil {
		l.Kind = KindCatalog
		if it, ok := items[*m.VariantID]; ok {
			snap := snapshotOf(it)
			l.Snapshot = &snap
			l.UnitPrice = money.USD(price(it.UnitPrice))
		}
	} else {
		l.UnitPrice = money.USD(price(deref(m.UnitPrice)))
	}
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

// catalogLine makes sure a catalog line's variant has a snapshot (taken now
// at its first appearance); bom.variant_not_found when the variant neither
// exists nor has a snapshot.
func (s *Service) catalogLine(ctx context.Context, q *store.Queries, ref projects.VersionRef, v manualValues) error {
	if v.variantID == nil {
		return nil
	}
	if err := s.ensureSnapshots(ctx, q, ref, []uuid.UUID{*v.variantID}); err != nil {
		return err
	}
	ids, err := q.ItemVariantIDs(ctx, ref.ID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id == *v.variantID {
			return nil
		}
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
		if err := s.catalogLine(ctx, q, ref, v); err != nil {
			return err
		}
		row, err := q.InsertManualLine(ctx, store.InsertManualLineParams{
			TenantID: ref.TenantID, VersionID: versionID, VariantID: v.variantID, Name: v.name, UnitPrice: v.unitPrice,
			Quantity: v.quantity, Note: v.note,
		})
		if err != nil {
			return err
		}
		out, err = s.lineOut(ctx, q, row)
		return err
	})
	return out, err
}

func (s *Service) lineOut(ctx context.Context, q *store.Queries, row store.VersionManualLine) (ManualLine, error) {
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
	return manualLineOf(row, items), nil
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
	var out ManualLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, row, err := s.lockLine(ctx, tx, q, versionID, id)
		if err != nil {
			return err
		}
		if !row.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
			return apperr.Conflict("bom.line_stale", "the line was changed by someone else")
		}
		if err := s.catalogLine(ctx, q, ref, v); err != nil {
			return err
		}
		row, err = q.UpdateManualLine(ctx, store.UpdateManualLineParams{
			ID: id, VariantID: v.variantID, Name: v.name, UnitPrice: v.unitPrice, Quantity: v.quantity, Note: v.note,
		})
		if err != nil {
			return err
		}
		out, err = s.lineOut(ctx, q, row)
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
