package projects

// Exchange rates of projects (spec "Exchange rates online"): a non-USD
// project's rate is fetched from the online provider or entered by hand, and
// remembers its source and date. A manual rate is never replaced
// automatically; a non-USD project may have no rate yet (converted amounts
// are then omitted). The provider is never called inside a transaction
// (D243).

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/projects/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// DefaultMaxRateAgeDays is when an online rate counts as stale unless
// configured (EXCHANGE_RATE_MAX_AGE_DAYS).
const DefaultMaxRateAgeDays = 7

// Rate sources.
const (
	RateSourceNone   = "none"
	RateSourceOnline = "online"
	RateSourceManual = "manual"
)

// rateValue is a project's rate as stored (rate nil: none yet).
type rateValue struct {
	rate     *string
	date     *time.Time
	source   *string
	provider string
}

func ptr[T any](v T) *T { return &v }

var usdRate = rateValue{rate: ptr("1")}

func storedRate(p *store.Project) rateValue {
	return rateValue{rate: p.ExchangeRate, date: p.ExchangeRateDate, source: p.ExchangeRateSource, provider: p.ExchangeRateProvider}
}

func onlineRate(r exchangerate.Rate) rateValue {
	return rateValue{rate: ptr(r.Rate.String()), date: ptr(r.Date), source: ptr(RateSourceOnline), provider: r.Provider}
}

func (s *Service) manualRate(rate string) rateValue {
	return rateValue{rate: &rate, date: ptr(s.now().UTC()), source: ptr(RateSourceManual)}
}

// validateRate decides the rate of a project with currency (valid): USD has
// 1; source online fetches the provider's rate; a changed rate is manual
// (today); an unchanged or missing rate keeps the stored one while the
// currency stays, else there is none yet.
func (s *Service) validateRate(ctx context.Context, currency string, in ProjectInput, current *store.Project) (rateValue, *apperr.FieldError, error) {
	sent := strings.TrimSpace(in.ExchangeRate)
	if currency == DefaultCurrency {
		if sent != "" {
			if r, ok := new(big.Rat).SetString(sent); !ok || r.Cmp(big.NewRat(1, 1)) != 0 {
				return usdRate, ptr(apperr.Field("body.exchangeRate", "project.exchange_rate", "USD has the exchange rate 1")), nil
			}
		}
		return usdRate, nil, nil
	}
	sameCurrency := current != nil && current.Currency == currency
	switch in.ExchangeRateSource {
	case RateSourceOnline:
		r, err := s.rates.Get(ctx, currency)
		if err != nil {
			return rateValue{}, nil, err
		}
		return onlineRate(r), nil, nil
	case "", RateSourceManual:
	default:
		return rateValue{}, ptr(apperr.Field("body.exchangeRateSource", "validation.invalid", "online or manual")), nil
	}
	if sent == "" {
		if sameCurrency {
			return storedRate(current), nil, nil
		}
		return rateValue{}, nil, nil
	}
	if f := checkRate("body.exchangeRate", sent); f != nil {
		return rateValue{}, f, nil
	}
	if sameCurrency && current.ExchangeRate != nil && sameNumber(sent, *current.ExchangeRate) &&
		in.ExchangeRateSource != RateSourceManual {
		return storedRate(current), nil, nil
	}
	if !sameCurrency && !in.ExchangeRateConfirmed {
		if f := s.implausible(currency, sent); f != nil {
			return rateValue{}, f, nil
		}
	}
	return s.manualRate(sent), nil, nil
}

// PlausibleFactor is how far a rate typed in with a new currency may be off
// the cached online rate before it needs exchangeRateConfirmed (D278).
const PlausibleFactor = 10

// implausible refuses a manual rate of a new currency that is more than
// PlausibleFactor off the cached online rate (a rate typed for the old
// currency); only the cache is asked, never the provider.
func (s *Service) implausible(currency, sent string) *apperr.FieldError {
	online, ok := s.rates.Cached(currency)
	if !ok {
		return nil
	}
	r, err := money.Parse(sent)
	if err != nil || r.Sign() <= 0 {
		return nil
	}
	f := money.MustParse(fmt.Sprint(PlausibleFactor))
	if r.GreaterThan(online.Mul(f)) || r.Mul(f).LessThan(online) {
		return ptr(apperr.Field("body.exchangeRate", "project.exchange_rate_implausible", "far off the online rate; confirm to store it").
			With("currency", currency).With("online", online.String()))
	}
	return nil
}

func checkRate(location, rate string) *apperr.FieldError {
	r, ok := new(big.Rat).SetString(rate)
	if !ratePattern.MatchString(rate) || !ok || r.Sign() <= 0 {
		return ptr(apperr.Field(location, "project.exchange_rate", "the exchange rate must be a number above 0"))
	}
	return nil
}

func sameNumber(a, b string) bool {
	x, ok1 := new(big.Rat).SetString(a)
	y, ok2 := new(big.Rat).SetString(b)
	return ok1 && ok2 && x.Cmp(y) == 0
}

// setRate fills the rate fields of p from row.
func (s *Service) setRate(p *Project, row store.Project) {
	p.ExchangeRateSource = RateSourceNone
	p.ExchangeRateMaxAgeDays = s.maxRateAge
	if row.ExchangeRate != nil {
		r := trimRate(*row.ExchangeRate)
		p.ExchangeRate = &r
	}
	if row.Currency == DefaultCurrency || row.ExchangeRate == nil {
		return
	}
	if row.ExchangeRateSource != nil {
		p.ExchangeRateSource = *row.ExchangeRateSource
	}
	p.ExchangeRateDate = row.ExchangeRateDate
	p.ExchangeRateProvider = row.ExchangeRateProvider
	if row.ExchangeRateDate != nil {
		p.ExchangeRateAgeDays = int(s.now().Sub(*row.ExchangeRateDate) / (24 * time.Hour))
		if p.ExchangeRateAgeDays < 0 {
			p.ExchangeRateAgeDays = 0
		}
	}
	p.ExchangeRateStale = p.ExchangeRateSource == RateSourceOnline && p.ExchangeRateAgeDays > s.maxRateAge
}

// RefreshRate stores the provider's current rate in a non-USD project
// (projects.write; the project active). One action: no stale check, the
// project's updatedAt moves.
// currency, when given, is the currency the client saw: project.stale (409)
// when the project's differs.
func (s *Service) RefreshRate(ctx context.Context, id uuid.UUID, currency string) (Project, error) {
	return s.changeRate(ctx, id, currency, func(currency string) (rateValue, error) {
		r, err := s.rates.Get(ctx, currency)
		if err != nil {
			return rateValue{}, err
		}
		return onlineRate(r), nil
	})
}

// SetRate stores a rate entered by hand in a non-USD project (as RefreshRate).
func (s *Service) SetRate(ctx context.Context, id uuid.UUID, in ExchangeRateSet) (Project, error) {
	rate := strings.TrimSpace(in.Rate)
	if f := checkRate("body.rate", rate); f != nil {
		if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
			return Project{}, err
		}
		return Project{}, apperr.Validation(*f)
	}
	return s.changeRate(ctx, id, in.Currency, func(string) (rateValue, error) { return s.manualRate(rate), nil })
}

// changeRate reads the project, gets the new rate outside any transaction
// (the provider may be slow, D243), then stores it under the project's lock
// (as Update, D169/D171) if the currency is still the same. seen is the
// currency the client saw (empty: not checked).
func (s *Service) changeRate(ctx context.Context, id uuid.UUID, seen string, get func(currency string) (rateValue, error)) (Project, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Project{}, err
	}
	var current store.Project
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		current, err = visible(ctx, actor, q.GetProject, id)
		return err
	})
	if err != nil {
		return Project{}, err
	}
	if ProjectStatus(current.Status) != StatusActive {
		return Project{}, errReadOnly()
	}
	if seen != "" && seen != current.Currency {
		return Project{}, errStale()
	}
	if current.Currency == DefaultCurrency {
		return Project{}, apperr.Conflict("project.exchange_rate_usd", "USD projects have no exchange rate to set")
	}
	v, err := get(current.Currency)
	if err != nil {
		return Project{}, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(q *store.Queries) error {
		locked, err := visible(ctx, actor, q.LockProject, id)
		if err != nil {
			return err
		}
		if ProjectStatus(locked.Status) != StatusActive {
			return errReadOnly()
		}
		if locked.Currency != current.Currency {
			return errStale()
		}
		_, err = q.SetExchangeRate(ctx, store.SetExchangeRateParams{
			ID: id, ExchangeRate: v.rate, ExchangeRateDate: v.date, ExchangeRateSource: v.source, ExchangeRateProvider: v.provider,
		})
		return err
	})
	if err != nil {
		return Project{}, err
	}
	return s.detail(ctx, actor, id)
}

// Currencies lists the currencies a project may use (projects.read); the
// recent ones are tenantID's (nil: the caller's; a tenant the caller does
// not see has none).
func (s *Service) Currencies(ctx context.Context, tenantID *uuid.UUID) (CurrencyList, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return CurrencyList{}, err
	}
	tenant := actor.TenantID
	if tenantID != nil {
		tenant = *tenantID
	}
	online, known := s.rates.Has(ctx)
	out := CurrencyList{Items: []Currency{}, Recent: []string{}, OnlineKnown: known}
	if !actor.SeesTenant(tenant) {
		tenant = uuid.Nil
	}
	for _, c := range money.Currencies() {
		out.Items = append(out.Items, Currency{Code: c, MinorUnits: money.MinorUnits(c), Online: online[c] || c == DefaultCurrency})
	}
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		recent, err := q.RecentCurrencies(ctx, tenant)
		if err != nil {
			return err
		}
		for _, c := range recent {
			if money.IsCurrency(c) {
				out.Recent = append(out.Recent, c)
			}
		}
		return nil
	})
	return out, err
}

// ExchangeRate returns the provider's current rate of currency
// (projects.read).
func (s *Service) ExchangeRate(ctx context.Context, currency string) (ExchangeRate, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return ExchangeRate{}, err
	}
	if !money.IsCurrency(currency) {
		return ExchangeRate{}, apperr.New(http.StatusNotFound, "project.currency_unknown", "not a supported ISO 4217 currency").With("currency", currency)
	}
	if currency == DefaultCurrency {
		return ExchangeRate{Currency: currency, Rate: "1", Date: s.now().UTC()}, nil
	}
	r, err := s.rates.Get(ctx, currency)
	if err != nil {
		return ExchangeRate{}, err
	}
	return ExchangeRate{Currency: currency, Rate: r.Rate.String(), Date: r.Date, Provider: r.Provider}, nil
}
