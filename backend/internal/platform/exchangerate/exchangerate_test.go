package exchangerate_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
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
	if has, known := c.Has(context.Background()); !known || !has["EUR"] || has["XXX"] || has["BAD"] {
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
	now = now.Add(exchangerate.Backoff) // not asked again right after a failure
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

// counting is a provider that counts its calls; block holds them until
// released, err makes them fail.
type counting struct {
	mu    sync.Mutex
	calls int
	err   error
	rates map[string]string
	block chan struct{}
}

func (p *counting) Fetch(ctx context.Context) (exchangerate.Rates, error) {
	p.mu.Lock()
	p.calls++
	block, err := p.block, p.err
	p.mu.Unlock()
	if block != nil {
		<-block
	}
	if err != nil {
		return exchangerate.Rates{}, err
	}
	if ctx.Err() != nil {
		return exchangerate.Rates{}, ctx.Err()
	}
	r := exchangerate.Rates{Provider: "fake", Date: time.Unix(1792368000, 0), Rates: map[string]money.Amount{}}
	for k, v := range p.rates {
		r.Rates[k] = money.MustParse(v)
	}
	return r, nil
}

func (p *counting) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func (p *counting) set(f func(p *counting)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f(p)
}

// clock is a fake clock.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestSingleFlight(t *testing.T) {
	p := &counting{rates: map[string]string{"EUR": "0.9"}, block: make(chan struct{})}
	c := exchangerate.New(p)
	var wg sync.WaitGroup
	errs := make(chan error, 10)
	for range 10 {
		wg.Go(func() {
			_, err := c.Get(context.Background(), "EUR")
			errs <- err
		})
	}
	// A caller that gives up does not cancel the fetch the others wait for.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.Get(ctx, "EUR")
		done <- err
	}()
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled caller got a rate before the fetch ended")
	}
	time.Sleep(20 * time.Millisecond)
	close(p.block)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if p.count() != 1 {
		t.Fatalf("one fetch for all: %d", p.count())
	}
}

func TestBackoff(t *testing.T) {
	clk := &clock{now: time.Unix(1792368000, 0)}
	p := &counting{rates: map[string]string{"EUR": "0.9"}}
	c := exchangerate.New(p)
	c.SetClock(clk.Now)
	if _, err := c.Get(context.Background(), "EUR"); err != nil {
		t.Fatal(err)
	}
	p.set(func(p *counting) { p.err = errors.New("down") })
	clk.Add(exchangerate.CacheFor)
	if _, err := c.Get(context.Background(), "EUR"); err != nil {
		t.Fatalf("stale cache: %v", err)
	}
	if p.count() != 2 {
		t.Fatalf("asked after expiry: %d", p.count())
	}
	clk.Add(exchangerate.Backoff / 2)
	if _, err := c.Get(context.Background(), "EUR"); err != nil || p.count() != 2 {
		t.Fatalf("backing off: %v, %d calls", err, p.count())
	}
	if _, known := c.Has(context.Background()); !known || p.count() != 2 {
		t.Fatalf("has while backing off: %v, %d", known, p.count())
	}
	clk.Add(exchangerate.Backoff)
	p.set(func(p *counting) { p.err = nil; p.rates = map[string]string{"EUR": "0.95"} })
	if r, err := c.Get(context.Background(), "EUR"); err != nil || r.Rate.String() != "0.95" || p.count() != 3 {
		t.Fatalf("after backoff: %v %v %d", r, err, p.count())
	}
}

func TestHasIsCacheOnly(t *testing.T) {
	p := &counting{rates: map[string]string{"EUR": "0.9"}, block: make(chan struct{})}
	c := exchangerate.New(p)
	has, known := c.Has(context.Background())
	if known || len(has) != 0 {
		t.Fatalf("nothing cached: %v %v", has, known)
	}
	if _, ok := c.Cached("EUR"); ok {
		t.Fatal("cached before any fetch")
	}
	close(p.block) // the background fetch ends
	deadline := time.Now().Add(2 * time.Second)
	for {
		if has, known := c.Has(context.Background()); known && has["EUR"] {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background fetch did not fill the cache")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if r, ok := c.Cached("EUR"); !ok || r.String() != "0.9" || p.count() != 1 {
		t.Fatalf("cached: %v %v %d", r, ok, p.count())
	}
}

func TestUnusable(t *testing.T) {
	p := &counting{rates: map[string]string{"TINY": "0.0000001", "HUGE": "123456789", "OK": "99999999.9999991"}}
	c := exchangerate.New(p)
	var ae *apperr.Error
	for _, code := range []string{"TINY", "HUGE"} {
		if _, err := c.Get(context.Background(), code); !errors.As(err, &ae) || ae.Code != "exchange_rate.unusable" || ae.Status != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %v", code, err)
		}
	}
	if r, err := c.Get(context.Background(), "OK"); err != nil || r.Rate.String() != "99999999.999999" {
		t.Fatalf("ok: %v %v", r, err)
	}
	if has, _ := c.Has(context.Background()); has["TINY"] || has["HUGE"] || !has["OK"] {
		t.Fatalf("has: %v", has)
	}
}

func serve(t *testing.T, status int, body string) *exchangerate.HTTP {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return exchangerate.NewHTTP(srv.URL)
}

func TestFetchErrors(t *testing.T) {
	ok := `{"result":"success","time_last_update_unix":1792368000,"base_code":"USD","rates":{"EUR":0.9}}`
	for name, tc := range map[string]struct {
		status int
		body   string
	}{
		"non-200":        {http.StatusServiceUnavailable, ok},
		"malformed json": {http.StatusOK, `{"result":"success",`},
		"result error":   {http.StatusOK, `{"result":"error","error-type":"quota-reached"}`},
		"other base":     {http.StatusOK, `{"result":"success","base_code":"EUR","rates":{"USD":1.1}}`},
		"no rates":       {http.StatusOK, `{"result":"success","base_code":"USD","rates":{}}`},
		"over 1 MiB":     {http.StatusOK, `{"result":"success","base_code":"USD","rates":{"EUR":0.9},"pad":"` + strings.Repeat("x", 1<<20) + `"}`},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := serve(t, tc.status, tc.body).Fetch(context.Background()); err == nil {
				t.Fatal("no error")
			}
		})
	}
}

func TestFetchValues(t *testing.T) {
	h := serve(t, http.StatusOK, `{"result":"success","time_last_update_unix":0,"base_code":"USD",
		"rates":{"EUR":0.9,"STR":"0.9","NUL":null,"EXP":1e-3,"NEG":-1}}`)
	before := time.Now().Add(-time.Second)
	r, err := h.Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Rates["EUR"]; !ok || len(r.Rates) != 2 {
		t.Fatalf("only plain decimals: %v", r.Rates)
	}
	if r.Date.Before(before) {
		t.Fatalf("time 0 means now: %v", r.Date)
	}
	// A negative rate is parsed but never usable.
	c := exchangerate.New(h)
	var ae *apperr.Error
	if _, err := c.Get(context.Background(), "NEG"); !errors.As(err, &ae) || ae.Code != "exchange_rate.unknown_currency" {
		t.Fatalf("neg: %v", err)
	}
	for _, code := range []string{"STR", "NUL", "EXP"} {
		if _, err := c.Get(context.Background(), code); !errors.As(err, &ae) || ae.Code != "exchange_rate.unknown_currency" {
			t.Fatalf("%s: %v", code, err)
		}
	}
}
