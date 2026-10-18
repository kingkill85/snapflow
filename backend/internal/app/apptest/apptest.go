// Package apptest runs the complete API (middleware and all features) against
// the test database, with helpers to log in as any role.
//
//	func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }
//	func TestX(t *testing.T) {
//		api := apptest.New(t)
//		resp := api.Get("/api/users", api.Admin.Cookie)
//	}
package apptest

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

const (
	AdminEmail = "admin@snapflow.test"
	// Password is the password of every user the helpers create.
	Password = "test-password"
)

type API struct {
	humatest.TestAPI
	t *testing.T
	// Admin is logged in as the bootstrap admin of the distributor tenant.
	Admin Session
	// Distributor is the distributor tenant's ID.
	Distributor uuid.UUID
}

// Session is a logged-in user. Pass Cookie as a request argument.
type Session struct {
	Cookie   string
	Token    string
	UserID   uuid.UUID
	TenantID uuid.UUID
	Email    string
}

// New returns the API on an emptied database with the distributor tenant and
// a logged-in admin.
func New(t *testing.T) *API {
	t.Helper()
	pool := testdb.Pool(t)
	if err := app.Bootstrap(context.Background(), pool, app.BootstrapConfig{
		DistributorName: "Distributor", AdminEmail: AdminEmail, AdminPassword: Password,
	}); err != nil {
		t.Fatalf("apptest: bootstrap: %v", err)
	}
	_, api := app.New(app.Deps{DB: pool})
	a := &API{TestAPI: humatest.Wrap(t, api), t: t}
	a.Admin = a.Login(AdminEmail, Password)
	a.Distributor = a.Admin.TenantID
	return a
}

// Login logs in and fails the test if that does not work.
func (a *API) Login(email, password string) Session {
	a.t.Helper()
	resp := a.Post("/api/auth/login", map[string]any{"email": email, "password": password})
	if resp.Code != http.StatusOK {
		a.t.Fatalf("apptest: login %s: got %d: %s", email, resp.Code, resp.Body)
	}
	var me struct {
		ID       uuid.UUID `json:"id"`
		TenantID uuid.UUID `json:"tenantId"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &me); err != nil {
		a.t.Fatalf("apptest: login response: %v", err)
	}
	for _, c := range resp.Result().Cookies() {
		if c.Name == auth.CookieName {
			return Session{
				Cookie: fmt.Sprintf("Cookie: %s=%s", c.Name, c.Value), Token: c.Value,
				UserID: me.ID, TenantID: me.TenantID, Email: email,
			}
		}
	}
	a.t.Fatal("apptest: login set no session cookie")
	return Session{}
}

// NewTenant creates an active partner tenant.
func (a *API) NewTenant(name string) uuid.UUID {
	a.t.Helper()
	resp := a.Post("/api/tenants", a.Admin.Cookie, map[string]any{"name": name, "isActive": true})
	if resp.Code != http.StatusCreated {
		a.t.Fatalf("apptest: create tenant: got %d: %s", resp.Code, resp.Body)
	}
	return decodeID(a.t, resp.Body.Bytes())
}

var userSeq atomic.Int64

// NewUser creates an active user with the given role in a tenant and logs
// them in.
func (a *API) NewUser(tenantID uuid.UUID, role auth.Role) Session {
	a.t.Helper()
	email := fmt.Sprintf("%s-%d@snapflow.test", role, userSeq.Add(1))
	resp := a.Post("/api/users", a.Admin.Cookie, map[string]any{
		"email": email, "fullName": string(role), "role": role, "tenantId": tenantID,
		"isActive": true, "password": Password,
	})
	if resp.Code != http.StatusCreated {
		a.t.Fatalf("apptest: create user: got %d: %s", resp.Code, resp.Body)
	}
	return a.Login(email, Password)
}

func decodeID(t *testing.T, body []byte) uuid.UUID {
	t.Helper()
	var v struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("apptest: decode id: %v", err)
	}
	return v.ID
}
