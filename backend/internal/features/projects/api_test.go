package projects_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func wantCode(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("want %d %s, got %d: %s", status, code, resp.Code, resp.Body)
	}
	if code != "" && !strings.Contains(resp.Body.String(), `"`+code+`"`) {
		t.Fatalf("want code %s: %s", code, resp.Body)
	}
}

// newType creates a product type and returns its id.
func newType(t *testing.T, api *apptest.API, key string, active bool) uuid.UUID {
	t.Helper()
	resp := api.Post("/api/product-types", api.Admin.Cookie, map[string]any{
		"key": key, "name": map[string]string{"en": key}, "isActive": active,
	})
	wantCode(t, resp, http.StatusCreated, "")
	return decode[struct{ ID uuid.UUID }](t, resp).ID
}

func create(t *testing.T, api *apptest.API, cookie string, body map[string]any) projects.Project {
	t.Helper()
	resp := api.Post("/api/projects", cookie, body)
	wantCode(t, resp, http.StatusCreated, "")
	return decode[projects.Project](t, resp)
}

func get(t *testing.T, api *apptest.API, cookie string, id uuid.UUID) projects.Project {
	t.Helper()
	resp := api.Get("/api/projects/"+id.String(), cookie)
	wantCode(t, resp, http.StatusOK, "")
	return decode[projects.Project](t, resp)
}

// updateBody is the project as the edit dialog sends it back.
func updateBody(p projects.Project) map[string]any {
	return map[string]any{
		"name": p.Name, "language": p.Language, "currency": p.Currency, "exchangeRate": p.ExchangeRate,
		"customer": p.Customer, "notes": p.Notes, "productTypeIds": p.ProductTypeIDs,
		"status": p.Status, "expectedUpdatedAt": p.UpdatedAt,
	}
}

func TestCRUD(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	zigbee := newType(t, api, "zigbee", true)
	knx := newType(t, api, "knx", true)
	newType(t, api, "old", false)

	p := create(t, api, admin, map[string]any{
		"name": "  Villa Müller ", "customer": map[string]any{"name": "Anna Müller", "email": "anna@example.com", "address": "Street 1\r\nTown"},
	})
	year := time.Now().UTC().Year()
	if p.Number != fmt.Sprintf("%d-0001", year) || p.Name != "Villa Müller" || p.Status != projects.StatusActive ||
		p.Language != "en" || p.Currency != "USD" || p.ExchangeRate != "1" || p.Customer.Address != "Street 1\nTown" {
		t.Errorf("created: %+v", p)
	}
	if len(p.ProductTypeIDs) != 2 || p.ProductTypeIDs[0] != zigbee || p.ProductTypeIDs[1] != knx {
		t.Errorf("default product types (all active, catalog order): %v", p.ProductTypeIDs)
	}
	if len(p.Versions) != 1 || p.Versions[0].Name != "V1" || p.Versions[0].Can.Delete || p.NextVersionName != "V2" {
		t.Errorf("first version: %+v next %s", p.Versions, p.NextVersionName)
	}
	if !p.Can.Update || !p.Can.Delete || p.Can.Reopen || p.Tenant == nil || p.Tenant.Name != "Distributor" {
		t.Errorf("can/tenant: %+v %+v", p.Can, p.Tenant)
	}

	body := updateBody(p)
	body["name"] = "Villa Schmidt"
	body["currency"] = "EUR"
	body["exchangeRate"] = "0.920000"
	body["language"] = "de"
	body["productTypeIds"] = []uuid.UUID{knx}
	body["customer"] = map[string]any{"company": "Schmidt GmbH"}
	resp := api.Put("/api/projects/"+p.ID.String(), admin, body)
	wantCode(t, resp, http.StatusOK, "")
	u := decode[projects.Project](t, resp)
	if u.Name != "Villa Schmidt" || u.Currency != "EUR" || u.ExchangeRate != "0.92" || u.Language != "de" ||
		u.Customer.Name != "" || u.Customer.Company != "Schmidt GmbH" || len(u.ProductTypeIDs) != 1 || u.Number != p.Number {
		t.Errorf("updated: %+v", u)
	}

	// Stale.
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), admin, body), http.StatusConflict, "project.stale")

	// List, search, status filter, paging.
	create(t, api, admin, map[string]any{"name": "Office Tower", "customer": map[string]any{"company": "ACME_corp"}})
	page := decode[projects.ProjectPage](t, api.Get("/api/projects?search=acme_", admin))
	if page.Total != 1 || page.Items[0].Name != "Office Tower" || page.Items[0].VersionCount != 1 || page.Items[0].Tenant == nil {
		t.Errorf("search: %+v", page)
	}
	page = decode[projects.ProjectPage](t, api.Get(fmt.Sprintf("/api/projects?search=%d-0001", year), admin))
	if page.Total != 1 || page.Items[0].ID != p.ID {
		t.Errorf("search by number: %+v", page)
	}
	page = decode[projects.ProjectPage](t, api.Get("/api/projects?limit=1", admin))
	if page.Total != 2 || len(page.Items) != 1 || page.Items[0].Name != "Office Tower" {
		t.Errorf("paging, newest first: %+v", page)
	}
	body = updateBody(u)
	body["status"] = "completed"
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), admin, body), http.StatusOK, "")
	if page = decode[projects.ProjectPage](t, api.Get("/api/projects", admin)); page.Total != 1 {
		t.Errorf("default filter is active: %+v", page)
	}
	if page = decode[projects.ProjectPage](t, api.Get("/api/projects?status=completed", admin)); page.Total != 1 || page.Items[0].ID != p.ID {
		t.Errorf("completed filter: %+v", page)
	}
	if page = decode[projects.ProjectPage](t, api.Get("/api/projects?status=all", admin)); page.Total != 2 {
		t.Errorf("all: %+v", page)
	}

	// Delete cascades (a completed project can be deleted).
	wantCode(t, api.Delete("/api/projects/"+p.ID.String(), admin), http.StatusNoContent, "")
	wantCode(t, api.Get("/api/projects/"+p.ID.String(), admin), http.StatusNotFound, "project.not_found")
	var versions int
	if err := api.DB.QueryRow(t.Context(), "SELECT count(*) FROM project_versions WHERE project_id = $1", p.ID).Scan(&versions); err != nil || versions != 0 {
		t.Errorf("versions left: %d %v", versions, err)
	}
	wantCode(t, api.Delete("/api/projects/"+p.ID.String(), admin), http.StatusNotFound, "project.not_found")

	// A product type a project uses cannot be deleted.
	wantCode(t, api.Delete("/api/product-types/"+zigbee.String(), admin), http.StatusConflict, "product_type.in_use")
}

func TestValidation(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	active := newType(t, api, "zigbee", true)
	inactive := newType(t, api, "old", false)

	cases := map[string]struct {
		body           map[string]any
		status         int
		code, location string
	}{
		"blank name":     {map[string]any{"name": "  "}, 422, "validation.required", "body.name"},
		"long name":      {map[string]any{"name": strings.Repeat("x", 201)}, 422, "validation.too_long", "body.name"},
		"control chars":  {map[string]any{"name": "a\tb"}, 422, "validation.control_chars", "body.name"},
		"email":          {map[string]any{"name": "x", "customer": map[string]any{"email": "nope"}}, 422, "validation.email", "body.customer.email"},
		"phone too long": {map[string]any{"name": "x", "customer": map[string]any{"phone": strings.Repeat("1", 51)}}, 422, "validation.too_long", "body.customer.phone"},
		"currency":       {map[string]any{"name": "x", "currency": "eur"}, 422, "project.currency_format", "body.currency"},
		"rate zero":      {map[string]any{"name": "x", "currency": "EUR", "exchangeRate": "0"}, 422, "project.exchange_rate", "body.exchangeRate"},
		"rate format":    {map[string]any{"name": "x", "currency": "EUR", "exchangeRate": "1e3"}, 422, "project.exchange_rate", "body.exchangeRate"},
		"usd rate":       {map[string]any{"name": "x", "exchangeRate": "2"}, 422, "project.exchange_rate", "body.exchangeRate"},
		"language":       {map[string]any{"name": "x", "language": "fr"}, 422, "validation.locale", "body.language"},
		"no types":       {map[string]any{"name": "x", "productTypeIds": []uuid.UUID{}}, 422, "project.product_types_required", "body.productTypeIds"},
		"unknown type":   {map[string]any{"name": "x", "productTypeIds": []uuid.UUID{active, uuid.New()}}, 422, "project.product_type_not_found", "body.productTypeIds[1]"},
		"inactive type":  {map[string]any{"name": "x", "productTypeIds": []uuid.UUID{inactive}}, 422, "project.product_type_inactive", "body.productTypeIds[0]"},
		"unknown tenant": {map[string]any{"name": "x", "tenantId": uuid.New()}, 422, "project.tenant_not_found", "body.tenantId"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			resp := api.Post("/api/projects", admin, c.body)
			wantCode(t, resp, c.status, c.code)
			if !strings.Contains(resp.Body.String(), `"location":"`+c.location+`"`) {
				t.Errorf("location %s: %s", c.location, resp.Body)
			}
		})
	}

	// An inactive type the project already has stays allowed.
	p := create(t, api, admin, map[string]any{"name": "x", "productTypeIds": []uuid.UUID{active}})
	if _, err := api.DB.Exec(t.Context(), "INSERT INTO project_product_types (tenant_id, project_id, product_type_id) VALUES ($1, $2, $3)",
		p.TenantID, p.ID, inactive); err != nil {
		t.Fatal(err)
	}
	p = get(t, api, admin, p.ID)
	body := updateBody(p)
	body["name"] = "y"
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), admin, body), http.StatusOK, "")
}

func TestReadOnly(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	newType(t, api, "zigbee", true)
	p := create(t, api, admin, map[string]any{"name": "Villa"})
	path := "/api/projects/" + p.ID.String()

	body := updateBody(p)
	body["status"] = "cancelled"
	p = decode[projects.Project](t, api.Put(path, admin, body))
	if p.Status != projects.StatusCancelled || p.Can.Update || !p.Can.Reopen || !p.Can.Delete || p.Versions[0].Can.Update {
		t.Fatalf("cancelled: %+v", p)
	}

	body = updateBody(p)
	body["name"] = "Changed"
	wantCode(t, api.Put(path, admin, body), http.StatusConflict, "project.read_only")
	body["status"] = "completed"
	wantCode(t, api.Put(path, admin, body), http.StatusConflict, "project.read_only")
	v := p.Versions[0]
	wantCode(t, api.Post(path+"/versions", admin, map[string]any{"name": "V2"}), http.StatusConflict, "project.read_only")
	wantCode(t, api.Put(path+"/versions/"+v.ID.String(), admin, map[string]any{"name": "X", "expectedUpdatedAt": v.UpdatedAt}),
		http.StatusConflict, "project.read_only")
	wantCode(t, api.Delete(path+"/versions/"+v.ID.String(), admin), http.StatusConflict, "project.read_only")

	// Reopen.
	body = updateBody(p)
	body["status"] = "active"
	p = decode[projects.Project](t, api.Put(path, admin, body))
	if p.Status != projects.StatusActive || !p.Can.Update {
		t.Fatalf("reopened: %+v", p)
	}
}

func TestVersions(t *testing.T) {
	api := apptest.New(t)
	admin := api.Admin.Cookie
	newType(t, api, "zigbee", true)
	p := create(t, api, admin, map[string]any{"name": "Villa"})
	path := "/api/projects/" + p.ID.String() + "/versions"
	v1 := p.Versions[0]

	// Rename with notes; stale.
	resp := api.Put(path+"/"+v1.ID.String(), admin, map[string]any{"name": "Basic", "notes": "cheap", "expectedUpdatedAt": v1.UpdatedAt})
	wantCode(t, resp, http.StatusOK, "")
	basic := decode[projects.ProjectVersion](t, resp)
	wantCode(t, api.Put(path+"/"+v1.ID.String(), admin, map[string]any{"name": "B", "expectedUpdatedAt": v1.UpdatedAt}),
		http.StatusConflict, "project_version.stale")

	// Copy and empty.
	resp = api.Post(path, admin, map[string]any{"name": "Premium", "sourceVersionId": basic.ID})
	wantCode(t, resp, http.StatusCreated, "")
	premium := decode[projects.ProjectVersion](t, resp)
	if premium.Notes != "cheap" || premium.Position != 2 || !premium.Can.Delete {
		t.Errorf("copy: %+v", premium)
	}
	resp = api.Post(path, admin, map[string]any{"name": "Fresh"})
	wantCode(t, resp, http.StatusCreated, "")
	if fresh := decode[projects.ProjectVersion](t, resp); fresh.Notes != "" || fresh.Position != 3 {
		t.Errorf("empty: %+v", fresh)
	}
	wantCode(t, api.Post(path, admin, map[string]any{"name": "basic"}), http.StatusConflict, "project_version.name_taken")
	wantCode(t, api.Post(path, admin, map[string]any{"name": " "}), http.StatusUnprocessableEntity, "validation.required")
	wantCode(t, api.Post(path, admin, map[string]any{"name": "X", "sourceVersionId": uuid.New()}),
		http.StatusUnprocessableEntity, "project_version.not_found")

	got := get(t, api, admin, p.ID)
	if len(got.Versions) != 3 || got.Versions[0].Name != "Basic" || got.Versions[2].Name != "Fresh" || got.NextVersionName != "V4" {
		t.Errorf("versions: %+v next %s", got.Versions, got.NextVersionName)
	}

	// Delete down to the last one.
	for _, v := range got.Versions[1:] {
		wantCode(t, api.Delete(path+"/"+v.ID.String(), admin), http.StatusNoContent, "")
	}
	wantCode(t, api.Delete(path+"/"+basic.ID.String(), admin), http.StatusConflict, "project_version.last")
	wantCode(t, api.Delete(path+"/"+uuid.NewString(), admin), http.StatusNotFound, "project_version.not_found")
}

func TestTenants(t *testing.T) {
	api := apptest.New(t)
	newType(t, api, "zigbee", true)
	acme := api.NewTenant("Acme")
	other := api.NewTenant("Other")
	acmeUser := api.NewUser(acme, auth.RoleUser)
	otherAdmin := api.NewUser(other, auth.RoleTenantAdmin)

	own := create(t, api, acmeUser.Cookie, map[string]any{"name": "Acme project"})
	if own.TenantID != acme || own.Tenant != nil || own.Can.Delete || !own.Can.Update {
		t.Errorf("user's project: %+v", own)
	}
	foreign := create(t, api, otherAdmin.Cookie, map[string]any{"name": "Other project"})

	// Others' projects look like 404, in every operation.
	path := "/api/projects/" + foreign.ID.String()
	wantCode(t, api.Get(path, acmeUser.Cookie), http.StatusNotFound, "project.not_found")
	wantCode(t, api.Put(path, acmeUser.Cookie, updateBody(foreign)), http.StatusNotFound, "project.not_found")
	wantCode(t, api.Delete(path, otherAdmin.Cookie), http.StatusNoContent, "") // own tenant: fine
	foreign = create(t, api, otherAdmin.Cookie, map[string]any{"name": "Other project"})
	path = "/api/projects/" + foreign.ID.String()
	acmeAdmin := api.NewUser(acme, auth.RoleTenantAdmin)
	wantCode(t, api.Delete(path, acmeAdmin.Cookie), http.StatusNotFound, "project.not_found")
	wantCode(t, api.Post(path+"/versions", acmeUser.Cookie, map[string]any{"name": "X"}), http.StatusNotFound, "project.not_found")
	wantCode(t, api.Delete(path+"/versions/"+foreign.Versions[0].ID.String(), acmeUser.Cookie), http.StatusNotFound, "project.not_found")
	wantCode(t, api.Delete(path, acmeUser.Cookie), http.StatusForbidden, "auth.forbidden") // users may not delete

	// Lists: own tenant only, whatever the filter says; admins see all.
	page := decode[projects.ProjectPage](t, api.Get("/api/projects?tenantId="+other.String(), acmeUser.Cookie))
	if page.Total != 1 || page.Items[0].ID != own.ID {
		t.Errorf("user list: %+v", page)
	}
	page = decode[projects.ProjectPage](t, api.Get("/api/projects", api.Admin.Cookie))
	if page.Total != 2 || page.Items[0].Tenant == nil {
		t.Errorf("admin list: %+v", page)
	}
	page = decode[projects.ProjectPage](t, api.Get("/api/projects?tenantId="+other.String(), api.Admin.Cookie))
	if page.Total != 1 || page.Items[0].Tenant.Name != "Other" {
		t.Errorf("admin tenant filter: %+v", page)
	}

	// Choosing a tenant needs tenants.access_all.
	wantCode(t, api.Post("/api/projects", acmeUser.Cookie, map[string]any{"name": "x", "tenantId": other}),
		http.StatusForbidden, "project.tenant_forbidden")
	p := create(t, api, api.Admin.Cookie, map[string]any{"name": "For Acme", "tenantId": acme})
	year := time.Now().UTC().Year()
	if p.TenantID != acme || p.Number != fmt.Sprintf("%d-0002", year) {
		t.Errorf("admin creates for acme: %+v", p)
	}

	// Moving gives a number in the new tenant; the versions move along.
	body := updateBody(p)
	body["tenantId"] = other
	resp := api.Put("/api/projects/"+p.ID.String(), api.Admin.Cookie, body)
	wantCode(t, resp, http.StatusOK, "")
	moved := decode[projects.Project](t, resp)
	if moved.TenantID != other || moved.Number != fmt.Sprintf("%d-0003", year) {
		t.Errorf("moved: %+v", moved)
	}
	var versionTenant uuid.UUID
	if err := api.DB.QueryRow(t.Context(), "SELECT tenant_id FROM project_versions WHERE project_id = $1", p.ID).Scan(&versionTenant); err != nil || versionTenant != other {
		t.Errorf("version tenant: %s %v", versionTenant, err)
	}
	wantCode(t, api.Get("/api/projects/"+p.ID.String(), acmeUser.Cookie), http.StatusNotFound, "project.not_found")
}

// Parallel creates in one tenant get distinct, gapless numbers.
func TestNumbersConcurrent(t *testing.T) {
	api := apptest.New(t)
	newType(t, api, "zigbee", true)
	const n = 20
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		numbers = map[string]bool{}
	)
	for range n {
		wg.Go(func() {
			resp := api.Post("/api/projects", api.Admin.Cookie, map[string]any{"name": "Parallel"})
			if resp.Code != http.StatusCreated {
				t.Errorf("create: %d %s", resp.Code, resp.Body)
				return
			}
			p := decode[projects.Project](t, resp)
			mu.Lock()
			numbers[p.Number] = true
			mu.Unlock()
		})
	}
	wg.Wait()
	year := time.Now().UTC().Year()
	for i := 1; i <= n; i++ {
		if !numbers[fmt.Sprintf("%d-%04d", year, i)] {
			t.Errorf("number %d missing: %v", i, numbers)
		}
	}
}

func TestPermissionsMatrixUnchanged(t *testing.T) {
	for role, want := range map[auth.Role][3]bool{
		auth.RoleAdmin: {true, true, true}, auth.RoleTenantAdmin: {true, true, true}, auth.RoleUser: {true, true, false},
	} {
		got := [3]bool{role.Can(auth.PermProjectsRead), role.Can(auth.PermProjectsWrite), role.Can(auth.PermProjectsDelete)}
		if got != want {
			t.Errorf("%s: %v", role, got)
		}
	}
}
