// Package exchangerate fetches current USD exchange rates from an online
// provider (spec "Exchange rates online"). The default provider is
// open.er-api.com (no API key, as SnapFlow 1). All rates of the provider are
// cached in memory for an hour; when the provider fails, the last rates are
// used while they are at most a day old, else every lookup is
// exchange_rate.unavailable (503). Callers never hold a database transaction
// while calling it (D243): a slow provider must not keep rows locked.
package exchangerate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// DefaultURL is the default provider's endpoint (USD base).
const DefaultURL = "https://open.er-api.com/v6/latest/USD"

const (
	// CacheFor is how long fetched rates are used without asking again.
	CacheFor = time.Hour
	// StaleFor is how old cached rates may be when the provider fails.
	StaleFor = 24 * time.Hour
	// Timeout bounds one provider request.
	Timeout = 10 * time.Second
	// Places are the decimals a rate is rounded to (numeric(14,6)).
	Places = 6
)

// Rates are the units of each currency per 1 USD at Date.
type Rates struct {
	// Provider names the source (the URL's host).
	Provider string
	// Date is the provider's last update of the rates.
	Date  time.Time
	Rates map[string]money.Amount
}

// Provider fetches the current rates.
type Provider interface {
	Fetch(ctx context.Context) (Rates, error)
}

// Rate is one currency's rate.
type Rate struct {
	Currency string
	// Rate is units of Currency per 1 USD, rounded to 6 decimals.
	Rate     money.Amount
	Date     time.Time
	Provider string
}

// Client caches a provider's rates. The provider is asked by one request at
// a time (singleflight), never under the client's lock, and on a context of
// its own (a caller giving up does not cancel the fetch others wait for).
// After a failure it is not asked again for Backoff; the stale cache serves
// meanwhile.
type Client struct {
	provider Provider
	now      func() time.Time
	flight   singleflight.Group

	mu       sync.Mutex
	rates    *Rates
	fetched  time.Time
	failedAt time.Time
}

// Backoff is how long the provider is not asked again after a failure.
const Backoff = 2 * time.Minute

// MaxRate bounds a usable rate: numeric(14,6) stores 8 integer digits.
var MaxRate = money.MustParse("99999999.999999")

// New returns a client of provider (nil: no provider; every lookup is
// unavailable).
func New(provider Provider) *Client { return &Client{provider: provider, now: time.Now} }

// SetClock replaces the clock (tests).
func (c *Client) SetClock(now func() time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

// ErrUnavailable is returned when no rates can be had.
func errUnavailable() *apperr.Error {
	return apperr.New(http.StatusServiceUnavailable, "exchange_rate.unavailable", "the exchange rate service is not reachable; try again later or enter the rate by hand")
}

// cached returns the cached rates if they are fresh (or, stale: at most
// StaleFor old); the caller holds mu.
func (c *Client) cached(now time.Time, maxAge time.Duration) (Rates, bool) {
	if c.rates != nil && now.Sub(c.fetched) < maxAge {
		return *c.rates, true
	}
	return Rates{}, false
}

// All returns the current rates (cached).
func (c *Client) All(ctx context.Context) (Rates, error) {
	c.mu.Lock()
	now := c.now()
	if r, ok := c.cached(now, CacheFor); ok {
		c.mu.Unlock()
		return r, nil
	}
	backingOff := !c.failedAt.IsZero() && now.Sub(c.failedAt) < Backoff
	c.mu.Unlock()
	if c.provider == nil {
		return Rates{}, errUnavailable()
	}
	if !backingOff {
		select {
		case <-c.start(ctx):
		case <-ctx.Done():
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now = c.now()
	if r, ok := c.cached(now, CacheFor); ok {
		return r, nil
	}
	if r, ok := c.cached(now, StaleFor); ok {
		return r, nil
	}
	return Rates{}, errUnavailable()
}

// start begins a fetch unless one runs; the channel is closed when it ends.
func (c *Client) start(ctx context.Context) <-chan singleflight.Result {
	bg := context.WithoutCancel(ctx)
	return c.flight.DoChan("rates", func() (any, error) {
		fctx, cancel := context.WithTimeout(bg, Timeout)
		defer cancel()
		r, err := c.provider.Fetch(fctx)
		c.mu.Lock()
		defer c.mu.Unlock()
		if err != nil {
			c.failedAt = c.now()
			slog.WarnContext(bg, "exchange rates: provider failed", "err", err)
			return nil, err
		}
		c.rates, c.fetched, c.failedAt = &r, c.now(), time.Time{}
		return nil, nil
	})
}

// usable rounds a provider's rate to Places and reports whether it can be
// stored (above 0 after rounding, within numeric(14,6)).
func usable(r money.Amount) (money.Amount, bool) {
	r = money.Round(r, Places)
	return r, r.Sign() > 0 && r.LessThanOrEqual(MaxRate)
}

// Get returns the current rate of currency; exchange_rate.unknown_currency
// (404) when the provider has none, exchange_rate.unusable (422) when its
// rate rounds to 0 or exceeds numeric(14,6).
func (c *Client) Get(ctx context.Context, currency string) (Rate, error) {
	all, err := c.All(ctx)
	if err != nil {
		return Rate{}, err
	}
	r, ok := all.Rates[currency]
	if !ok || r.Sign() <= 0 {
		return Rate{}, apperr.New(http.StatusNotFound, "exchange_rate.unknown_currency", "the exchange rate service has no rate for this currency").With("currency", currency)
	}
	rounded, ok := usable(r)
	if !ok {
		return Rate{}, apperr.New(http.StatusUnprocessableEntity, "exchange_rate.unusable", "the online rate of this currency cannot be stored; enter the rate by hand").With("currency", currency)
	}
	return Rate{Currency: currency, Rate: rounded, Date: all.Date, Provider: all.Provider}, nil
}

// Cached returns the cached rate of currency without asking the provider
// (ok false when none is cached within StaleFor or it is not usable).
func (c *Client) Cached(currency string) (money.Amount, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	all, ok := c.cached(c.now(), StaleFor)
	if !ok {
		return money.Zero, false
	}
	r, ok := all.Rates[currency]
	if !ok {
		return money.Zero, false
	}
	return usable(r)
}

// Has reports which currencies the provider has a usable rate for, from the
// cache only (known false when nothing is cached: a fetch then starts in the
// background, so a later call knows).
func (c *Client) Has(ctx context.Context) (has map[string]bool, known bool) {
	c.mu.Lock()
	now := c.now()
	all, ok := c.cached(now, StaleFor)
	expired := !ok || now.Sub(c.fetched) >= CacheFor
	backingOff := !c.failedAt.IsZero() && now.Sub(c.failedAt) < Backoff
	c.mu.Unlock()
	if expired && !backingOff && c.provider != nil {
		c.start(ctx)
	}
	out := map[string]bool{}
	for k, v := range all.Rates {
		_, out[k] = usable(v)
	}
	return out, ok
}

// HTTP is the open.er-api.com provider (any endpoint with its response
// format: {"result":"success","time_last_update_unix":…,"rates":{…}}).
type HTTP struct {
	URL    string
	Client *http.Client
}

// NewHTTP returns the provider at rawURL (empty: DefaultURL).
func NewHTTP(rawURL string) *HTTP {
	if rawURL == "" {
		rawURL = DefaultURL
	}
	return &HTTP{URL: rawURL, Client: &http.Client{Timeout: Timeout}}
}

type erAPIResponse struct {
	Result         string                     `json:"result"`
	TimeLastUpdate int64                      `json:"time_last_update_unix"`
	BaseCode       string                     `json:"base_code"`
	Rates          map[string]json.RawMessage `json:"rates"`
}

func (h *HTTP) Fetch(ctx context.Context) (Rates, error) {
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.URL, nil)
	if err != nil {
		return Rates{}, err
	}
	resp, err := h.Client.Do(req)
	if err != nil {
		return Rates{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return Rates{}, fmt.Errorf("exchange rates: %s", resp.Status)
	}
	var body erAPIResponse
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&body); err != nil {
		return Rates{}, fmt.Errorf("exchange rates: %w", err)
	}
	if body.Result != "success" || (body.BaseCode != "" && body.BaseCode != "USD") || len(body.Rates) == 0 {
		return Rates{}, errors.New("exchange rates: unexpected response")
	}
	out := Rates{Provider: providerName(h.URL), Date: time.Unix(body.TimeLastUpdate, 0).UTC(), Rates: make(map[string]money.Amount, len(body.Rates))}
	for k, raw := range body.Rates {
		v, err := money.Parse(strings.TrimSpace(string(raw)))
		if err != nil {
			continue // exponents and the like: not a usable rate
		}
		out.Rates[k] = v
	}
	if body.TimeLastUpdate == 0 {
		out.Date = time.Now().UTC()
	}
	return out, nil
}

func providerName(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Hostname()
}
