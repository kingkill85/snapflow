package exchangerate_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
)

const body = `{"result":"success","provider":"https://www.exchangerate-api.com","time_last_update_unix":1792368000,
"base_code":"USD","rates":{"USD":1,"EUR":0.923712345,"PKR":278.5,"BAD":1e-9}}`

// stub serves the provider's response; fail makes it answer 500.
func stub(t *testing.T) (*httptest.Server, *atomic.Bool, *atomic.Int32) {
	t.Helper()
	var fail atomic.Bool
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		if fail.Load() {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &fail, &calls
}

func TestGet(t *testing.T) {
	srv, _, calls := stub(t)
	c := exchangerate.New(exchangerate.NewHTTP(srv.URL))
	r, err := c.Get(context.Background(), "EUR")
	if err != nil {
		t.Fatal(err)
	}
	if r.Rate.String() != "0.923712" || r.Provider != "127.0.0.1" || !r.Date.Equal(time.Unix(1792368000, 0)) {
		t.Fatalf("got %+v", r)
	}
	if _, err := c.Get(context.Background(), "PKR"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("cached for an hour: %d calls", calls.Load())
	}
	var ae *apperr.Error
	if _, err := c.Get(context.Background(), "XXX"); !errors.As(err, &ae) || ae.Code != "exchange_rate.unknown_currency" {
		t.Fatalf("unknown currency: %v", err)
	}
	if has := c.Has(context.Background()); !has["EUR"] || has["XXX"] || has["BAD"] {
		t.Fatalf("has: %v", has)
	}
}

func TestFailureUsesCacheUntilStale(t *testing.T) {
	srv, fail, calls := stub(t)
	now := time.Now()
	c := exchangerate.New(exchangerate.NewHTTP(srv.URL))
	c.SetClock(func() time.Time { return now })
	if _, err := c.Get(context.Background(), "EUR"); err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	now = now.Add(2 * time.Hour) // cache expired: asks again, falls back
	if r, err := c.Get(context.Background(), "EUR"); err != nil || r.Rate.String() != "0.923712" {
		t.Fatalf("fallback: %v %v", r, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("asked again after an hour: %d calls", calls.Load())
	}
	now = now.Add(23 * time.Hour) // older than a day
	var ae *apperr.Error
	if _, err := c.Get(context.Background(), "EUR"); !errors.As(err, &ae) || ae.Status != http.StatusServiceUnavailable || ae.Code != "exchange_rate.unavailable" {
		t.Fatalf("stale: %v", err)
	}
	fail.Store(false)
	if _, err := c.Get(context.Background(), "EUR"); err != nil {
		t.Fatalf("recovered: %v", err)
	}
}

func TestNoProvider(t *testing.T) {
	var ae *apperr.Error
	if _, err := exchangerate.New(nil).Get(context.Background(), "EUR"); !errors.As(err, &ae) || ae.Code != "exchange_rate.unavailable" {
		t.Fatalf("got %v", err)
	}
}
