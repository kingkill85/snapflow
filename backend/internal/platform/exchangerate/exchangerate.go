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

// Client caches a provider's rates.
type Client struct {
	provider Provider
	now      func() time.Time

	mu      sync.Mutex
	rates   *Rates
	fetched time.Time
}

// New returns a client of provider (nil: no provider; every lookup is
// unavailable).
func New(provider Provider) *Client { return &Client{provider: provider, now: time.Now} }

// SetClock replaces the clock (tests).
func (c *Client) SetClock(now func() time.Time) { c.now = now }

// ErrUnavailable is returned when no rates can be had.
func errUnavailable() *apperr.Error {
	return apperr.New(http.StatusServiceUnavailable, "exchange_rate.unavailable", "the exchange rate service is not reachable; try again later or enter the rate by hand")
}

// All returns the current rates (cached).
func (c *Client) All(ctx context.Context) (Rates, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.rates != nil && now.Sub(c.fetched) < CacheFor {
		return *c.rates, nil
	}
	if c.provider == nil {
		return Rates{}, errUnavailable()
	}
	r, err := c.provider.Fetch(ctx)
	if err == nil {
		c.rates, c.fetched = &r, now
		return r, nil
	}
	slog.WarnContext(ctx, "exchange rates: provider failed", "err", err)
	if c.rates != nil && now.Sub(c.fetched) < StaleFor {
		return *c.rates, nil
	}
	return Rates{}, errUnavailable()
}

// Get returns the current rate of currency; exchange_rate.unknown_currency
// (404) when the provider has none.
func (c *Client) Get(ctx context.Context, currency string) (Rate, error) {
	all, err := c.All(ctx)
	if err != nil {
		return Rate{}, err
	}
	r, ok := all.Rates[currency]
	if !ok || r.Sign() <= 0 {
		return Rate{}, apperr.New(http.StatusNotFound, "exchange_rate.unknown_currency", "the exchange rate service has no rate for this currency").With("currency", currency)
	}
	return Rate{Currency: currency, Rate: money.Round(r, Places), Date: all.Date, Provider: all.Provider}, nil
}

// Has reports which currencies the provider has a rate for (best effort:
// none when it is unavailable).
func (c *Client) Has(ctx context.Context) map[string]bool {
	all, err := c.All(ctx)
	out := map[string]bool{}
	if err != nil {
		return out
	}
	for k, v := range all.Rates {
		out[k] = v.Sign() > 0
	}
	return out
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
