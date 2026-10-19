package bom

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// DefaultServicesLabel is the services label while a version has none.
var DefaultServicesLabel = i18n.Text{
	"en": "System design, programming & commissioning",
	"de": "Systemplanung, Programmierung & Inbetriebnahme",
}

// maxAmount is the largest USD amount numeric(12, 2) holds.
var maxAmount = money.MustParse("9999999999.99")

const maxLabelLength = 200

func (st *state) pricingOut() Pricing {
	if st.pricing == nil {
		return Pricing{DiscountKind: "none", DiscountValue: "0.00", ServicesKind: "none", ServicesValue: "0.00", ServicesLabel: DefaultServicesLabel}
	}
	p := st.pricing
	label := DefaultServicesLabel
	if p.ServicesLabel != nil && p.ServicesLabel.Valid() {
		label = *p.ServicesLabel
	}
	at := p.UpdatedAt
	return Pricing{
		DiscountKind: p.DiscountKind, DiscountValue: money.USD(price(p.DiscountValue)),
		ServicesKind: p.ServicesKind, ServicesValue: money.USD(price(p.ServicesValue)),
		ServicesLabel: label, UpdatedAt: &at,
	}
}

// validPricing checks pricing input; values of kind none become 0.
func validPricing(in PricingInput) (store.UpsertPricingParams, error) {
	var errs []apperr.FieldError
	value := func(loc, kind, raw string) string {
		switch kind {
		case "none":
			return "0"
		case "percent", "amount":
		default:
			errs = append(errs, apperr.Field(loc+"Kind", "validation.invalid", "none, percent or amount"))
			return "0"
		}
		d, err := money.Parse(strings.TrimSpace(raw))
		if err != nil || d.IsNegative() || !d.Equal(d.Round(2)) {
			errs = append(errs, apperr.Field(loc+"Value", "pricing.value_invalid", "a number >= 0 with at most 2 decimals"))
			return "0"
		}
		if kind == "percent" && d.GreaterThan(money.MustParse("100")) {
			errs = append(errs, apperr.Field(loc+"Value", "pricing.percent_range", "0-100").With("max", 100))
			return "0"
		}
		if d.GreaterThan(maxAmount) {
			errs = append(errs, apperr.Field(loc+"Value", "pricing.amount_range", "too large").With("max", maxAmount.String()))
			return "0"
		}
		return money.USD(d)
	}
	out := store.UpsertPricingParams{
		DiscountKind: in.DiscountKind, ServicesKind: in.ServicesKind,
	}
	out.DiscountValue = value("body.discount", in.DiscountKind, in.DiscountValue)
	out.ServicesValue = value("body.services", in.ServicesKind, in.ServicesValue)
	label := in.ServicesLabel.Trimmed()
	if len(label) > 0 {
		errs = append(errs, label.Check("body.servicesLabel", maxLabelLength)...)
		if !label.Valid() {
			errs = append(errs, apperr.Field("body.servicesLabel.en", "validation.required", "the English label is required"))
		}
		out.ServicesLabel = &label
	}
	if len(errs) > 0 {
		return out, apperr.Validation(errs...)
	}
	return out, nil
}

// pricingOf turns validated input into the pricing it would store.
func pricingOf(p store.UpsertPricingParams) Pricing {
	label := DefaultServicesLabel
	if p.ServicesLabel != nil {
		label = *p.ServicesLabel
	}
	return Pricing{
		DiscountKind: p.DiscountKind, DiscountValue: money.USD(price(p.DiscountValue)),
		ServicesKind: p.ServicesKind, ServicesValue: money.USD(price(p.ServicesValue)), ServicesLabel: label,
	}
}

// GetPricing returns a version's pricing.
func (s *Service) GetPricing(ctx context.Context, versionID uuid.UUID) (Pricing, error) {
	b, err := s.Get(ctx, versionID)
	return b.Pricing, err
}

// SavePricing stores a version's pricing; pricing.stale if it changed since
// in.ExpectedUpdatedAt (null: it had the defaults). Returns the new BOM.
func (s *Service) SavePricing(ctx context.Context, versionID uuid.UUID, in PricingUpdate) (BOM, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return BOM{}, err
	}
	params, err := validPricing(in.PricingInput)
	if err != nil {
		return BOM{}, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		// Exclusive: orders the first save of the defaults.
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		cur, err := q.LockPricing(ctx, versionID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if in.ExpectedUpdatedAt != nil {
				return errPricingStale()
			}
		case err != nil:
			return err
		case in.ExpectedUpdatedAt == nil || !cur.UpdatedAt.Equal(*in.ExpectedUpdatedAt):
			return errPricingStale()
		}
		params.VersionID, params.TenantID = versionID, ref.TenantID
		_, err = q.UpsertPricing(ctx, params)
		return err
	})
	if err != nil {
		return BOM{}, err
	}
	return s.Get(ctx, versionID)
}

// PreviewPricing returns the totals the version would have with the given
// pricing, without saving it.
func (s *Service) PreviewPricing(ctx context.Context, versionID uuid.UUID, in PricingInput) (Totals, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Totals{}, err
	}
	params, err := validPricing(in)
	if err != nil {
		return Totals{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Totals{}, err
	}
	b := st.bom()
	return st.totals(price(b.Totals.Subtotal), pricingOf(params)), nil
}

func errPricingStale() *apperr.Error {
	return apperr.Conflict("pricing.stale", "the pricing was changed by someone else")
}
