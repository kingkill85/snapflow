package projects_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
)

// ratesAPI is the API with a stub provider (EUR 0.9237, PKR 278.5);
// fail makes the provider answer 500.
func ratesAPI(t *testing.T) (*apptest.API, *atomic.Bool) {
	t.Helper()
	var fail atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"result":"success","time_last_update_unix":1792368000,"base_code":"USD","rates":{"USD":1,"EUR":0.9237,"PKR":278.5}}`))
	}))
	t.Cleanup(srv.Close)
	api := apptest.NewWithRates(t, exchangerate.New(exchangerate.NewHTTP(srv.URL)))
	newType(t, api, "zigbee", true)
	return api, &fail
}

func TestCreateWithoutRate(t *testing.T) {
	api, _ := ratesAPI(t)
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR"})
	if p.ExchangeRate != nil || p.ExchangeRateSource != projects.RateSourceNone || p.ExchangeRateMaxAgeDays != 7 {
		t.Fatalf("no rate yet: %+v", p)
	}
	usd := create(t, api, api.Admin.Cookie, map[string]any{"name": "USD house"})
	if deref(usd.ExchangeRate) != "1" || usd.ExchangeRateSource != projects.RateSourceNone {
		t.Fatalf("usd: %+v", usd)
	}
	// Edit dialog round trip without a rate keeps none.
	resp := api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, updateBody(p))
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); u.ExchangeRate != nil {
		t.Fatalf("kept no rate: %+v", u)
	}
}

func TestRefreshAndSetRate(t *testing.T) {
	api, fail := ratesAPI(t)
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR"})
	base := "/api/projects/" + p.ID.String() + "/exchange-rate"

	resp := api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{})
	wantCode(t, resp, http.StatusOK, "")
	r := decode[projects.Project](t, resp)
	if deref(r.ExchangeRate) != "0.9237" || r.ExchangeRateSource != projects.RateSourceOnline || r.ExchangeRateProvider != "127.0.0.1" ||
		r.ExchangeRateDate == nil || r.ExchangeRateDate.Unix() != 1792368000 || !r.UpdatedAt.After(p.UpdatedAt) {
		t.Fatalf("refresh: %+v", r)
	}

	resp = api.Put(base, api.Admin.Cookie, map[string]any{"rate": "0.95", "currency": "EUR"})
	wantCode(t, resp, http.StatusOK, "")
	m := decode[projects.Project](t, resp)
	if deref(m.ExchangeRate) != "0.95" || m.ExchangeRateSource != projects.RateSourceManual || m.ExchangeRateStale {
		t.Fatalf("manual: %+v", m)
	}
	// Saving the edit dialog unchanged keeps the manual rate and its source.
	resp = api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, updateBody(m))
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); u.ExchangeRateSource != projects.RateSourceManual || !u.ExchangeRateDate.Equal(*m.ExchangeRateDate) {
		t.Fatalf("kept manual: %+v", u)
	}
	// The dialog's "Fetch current rate" saves an online rate.
	body := updateBody(get(t, api, api.Admin.Cookie, p.ID))
	body["exchangeRate"], body["exchangeRateSource"] = "", "online"
	resp = api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, body)
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); deref(u.ExchangeRate) != "0.9237" || u.ExchangeRateSource != projects.RateSourceOnline {
		t.Fatalf("online via update: %+v", u)
	}
	// The provider's rates of 2026-10-16 are older than 7 days by now
	// only if the clock says so; stale is computed against the server's
	// clock, so it is not asserted here.

	wantCode(t, api.Put(base, api.Admin.Cookie, map[string]any{"rate": "0", "currency": "EUR"}), http.StatusUnprocessableEntity, "project.exchange_rate")
	usd := create(t, api, api.Admin.Cookie, map[string]any{"name": "USD"})
	wantCode(t, api.Post("/api/projects/"+usd.ID.String()+"/exchange-rate/refresh", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "project.exchange_rate_usd")

	// Another tenant's user does not see the project.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleTenantAdmin)
	wantCode(t, api.Post(base+"/refresh", other.Cookie, map[string]any{}), http.StatusNotFound, "")
	wantCode(t, api.Put(base, other.Cookie, map[string]any{"rate": "1.2", "currency": "EUR"}), http.StatusNotFound, "")

	// Provider down, cache still fresh: works; read-only projects refuse.
	fail.Store(true)
	wantCode(t, api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{}), http.StatusOK, "")
	cur := get(t, api, api.Admin.Cookie, p.ID)
	body = updateBody(cur)
	body["status"] = "completed"
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, body), http.StatusOK, "")
	wantCode(t, api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "project.read_only")
	wantCode(t, api.Put(base, api.Admin.Cookie, map[string]any{"rate": "1.2", "currency": "EUR"}), http.StatusConflict, "project.read_only")
}

func TestUnavailable(t *testing.T) {
	api, fail := ratesAPI(t)
	fail.Store(true)
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR"})
	wantCode(t, api.Post("/api/projects/"+p.ID.String()+"/exchange-rate/refresh", api.Admin.Cookie, map[string]any{}), http.StatusServiceUnavailable, "exchange_rate.unavailable")
	wantCode(t, api.Get("/api/exchange-rates/EUR", api.Admin.Cookie), http.StatusServiceUnavailable, "exchange_rate.unavailable")
	// Currencies still list, none online.
	resp := api.Get("/api/currencies", api.Admin.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	l := decode[projects.CurrencyList](t, resp)
	if i := slices.IndexFunc(l.Items, func(c projects.Currency) bool { return c.Code == "EUR" }); i < 0 || l.Items[i].Online {
		t.Fatalf("currencies: %+v", l.Items)
	}
}

func TestCurrenciesAndRate(t *testing.T) {
	api, _ := ratesAPI(t)
	create(t, api, api.Admin.Cookie, map[string]any{"name": "A", "currency": "PKR"})
	create(t, api, api.Admin.Cookie, map[string]any{"name": "B", "currency": "EUR", "exchangeRate": "0.9"})
	// The list asks the cache only; a rate lookup fills it.
	wantCode(t, api.Get("/api/exchange-rates/EUR", api.Admin.Cookie), http.StatusOK, "")
	resp := api.Get("/api/currencies", api.Admin.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	l := decode[projects.CurrencyList](t, resp)
	if !l.OnlineKnown || !slices.Equal(l.Recent, []string{"EUR", "PKR"}) {
		t.Fatalf("recent: %v", l.Recent)
	}
	byCode := map[string]projects.Currency{}
	for _, c := range l.Items {
		byCode[c.Code] = c
	}
	if !byCode["EUR"].Online || byCode["CHF"].Online || byCode["JPY"].MinorUnits != 0 || byCode["KWD"].MinorUnits != 3 {
		t.Fatalf("items: %+v", byCode)
	}
	// Another tenant has no recent currencies of this one.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	resp = api.Get("/api/currencies", other.Cookie)
	if l := decode[projects.CurrencyList](t, resp); len(l.Recent) != 0 {
		t.Fatalf("other tenant's recent: %v", l.Recent)
	}
	// The admin asks for the recent currencies of the project's tenant;
	// a user of another tenant gets none of a tenant they do not see.
	resp = api.Get("/api/currencies?tenantId="+other.TenantID.String(), api.Admin.Cookie)
	if l := decode[projects.CurrencyList](t, resp); len(l.Recent) != 0 {
		t.Fatalf("other tenant via admin: %v", l.Recent)
	}
	resp = api.Get("/api/currencies?tenantId="+api.Admin.TenantID.String(), other.Cookie)
	if l := decode[projects.CurrencyList](t, resp); len(l.Recent) != 0 {
		t.Fatalf("unseen tenant: %v", l.Recent)
	}

	resp = api.Get("/api/exchange-rates/EUR", api.Admin.Cookie)
	wantCode(t, resp, http.StatusOK, "")
	if r := decode[projects.ExchangeRate](t, resp); r.Rate != "0.9237" || r.Provider != "127.0.0.1" {
		t.Fatalf("rate: %+v", r)
	}
	wantCode(t, api.Get("/api/exchange-rates/XYZ", api.Admin.Cookie), http.StatusNotFound, "project.currency_unknown")
	wantCode(t, api.Get("/api/exchange-rates/CHF", api.Admin.Cookie), http.StatusNotFound, "exchange_rate.unknown_currency")
	wantCode(t, api.Get("/api/exchange-rates/EUR"), http.StatusUnauthorized, "")
}

func TestSetRateStaleCurrency(t *testing.T) {
	api, _ := ratesAPI(t)
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR"})
	base := "/api/projects/" + p.ID.String() + "/exchange-rate"
	// The client saw PKR (another tab changed the currency meanwhile).
	wantCode(t, api.Put(base, api.Admin.Cookie, map[string]any{"rate": "280", "currency": "PKR"}), http.StatusConflict, "project.stale")
	wantCode(t, api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{"currency": "PKR"}), http.StatusConflict, "project.stale")
	wantCode(t, api.Put(base, api.Admin.Cookie, map[string]any{"rate": "0.95"}), http.StatusUnprocessableEntity, "")
	wantCode(t, api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{"currency": "EUR"}), http.StatusOK, "")
	wantCode(t, api.Post(base+"/refresh", api.Admin.Cookie, map[string]any{}), http.StatusOK, "")
}

func TestUpdateRatePaths(t *testing.T) {
	api, _ := ratesAPI(t)
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "House", "currency": "EUR", "exchangeRate": "0.95"})
	path := "/api/projects/" + p.ID.String()
	put := func(change func(map[string]any)) *httptest.ResponseRecorder {
		body := updateBody(get(t, api, api.Admin.Cookie, p.ID))
		change(body)
		return api.Put(path, api.Admin.Cookie, body)
	}

	// A new currency without a rate: none.
	resp := put(func(b map[string]any) { b["currency"], b["exchangeRate"] = "PKR", "" })
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); u.ExchangeRate != nil || u.ExchangeRateSource != projects.RateSourceNone {
		t.Fatalf("currency change without rate: %+v", u)
	}
	// Online with a currency the provider does not have.
	wantCode(t, put(func(b map[string]any) { b["currency"], b["exchangeRate"], b["exchangeRateSource"] = "CHF", "", "online" }),
		http.StatusNotFound, "exchange_rate.unknown_currency")
	wantCode(t, put(func(b map[string]any) { b["currency"] = "XYZ" }), http.StatusUnprocessableEntity, "project.currency_unknown")
	wantCode(t, put(func(b map[string]any) { b["currency"], b["exchangeRate"] = "USD", "1.1" }), http.StatusUnprocessableEntity, "project.exchange_rate")

	// The same number sent as manual: a new date.
	resp = put(func(b map[string]any) { b["currency"], b["exchangeRate"] = "EUR", "0.95" })
	wantCode(t, resp, http.StatusOK, "")
	first := decode[projects.Project](t, resp)
	resp = put(func(b map[string]any) { b["exchangeRate"], b["exchangeRateSource"] = "0.95", "manual" })
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); u.ExchangeRateSource != projects.RateSourceManual || !u.ExchangeRateDate.After(*first.ExchangeRateDate) {
		t.Fatalf("manual again: %+v (was %v)", u, first.ExchangeRateDate)
	}

	// A rate typed for the old currency (EUR 0.95 sent with PKR) is far
	// off PKR's online rate: refused unless confirmed. Only the cache is
	// asked, so fill it first.
	wantCode(t, api.Get("/api/exchange-rates/PKR", api.Admin.Cookie), http.StatusOK, "")
	wantCode(t, put(func(b map[string]any) { b["currency"], b["exchangeRate"] = "PKR", "0.95" }),
		http.StatusUnprocessableEntity, "project.exchange_rate_implausible")
	resp = put(func(b map[string]any) { b["currency"], b["exchangeRate"], b["exchangeRateConfirmed"] = "PKR", "0.95", true })
	wantCode(t, resp, http.StatusOK, "")
	if u := decode[projects.Project](t, resp); deref(u.ExchangeRate) != "0.95" || u.ExchangeRateSource != projects.RateSourceManual {
		t.Fatalf("confirmed: %+v", u)
	}
	// A plausible rate of a new currency needs no confirmation.
	wantCode(t, put(func(b map[string]any) { b["currency"], b["exchangeRate"] = "EUR", "0.93" }), http.StatusOK, "")
}
