// Package auth defines who is calling (Actor), the roles and the permission
// matrix. It is the single source of every authorization rule: services call
// Require at the top of each operation, so the HTTP API and later the MCP
// server enforce the same checks.
package auth

import (
	"context"
	"net/http"
	"slices"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// Role is a user's role. Roles are ordered: a higher role includes the
// permissions of every lower one.
type Role string

const (
	// RoleAdmin works for the distributor and manages every tenant and the catalog.
	RoleAdmin Role = "admin"
	// RoleTenantAdmin manages the users of their own tenant.
	RoleTenantAdmin Role = "tenant_admin"
	// RoleUser plans projects in their own tenant.
	RoleUser Role = "user"
)

// Roles lists all roles, highest first.
var Roles = []Role{RoleAdmin, RoleTenantAdmin, RoleUser}

// Permission is one action a role may perform.
type Permission string

const (
	PermCatalogRead  Permission = "catalog.read"
	PermCatalogWrite Permission = "catalog.write"
	// PermProjectsRead, Write and Delete are enforced from phase 2 (projects).
	PermProjectsRead   Permission = "projects.read"
	PermProjectsWrite  Permission = "projects.write"
	PermProjectsDelete Permission = "projects.delete"
	PermUsersManage    Permission = "users.manage"
	PermTenantsManage  Permission = "tenants.manage"
	// PermTenantsAccessAll lifts the tenant boundary: the caller sees and
	// changes data of every tenant, not only their own.
	PermTenantsAccessAll Permission = "tenants.access_all"
)

// Permissions lists all permissions in display order.
var Permissions = []Permission{
	PermCatalogRead, PermCatalogWrite,
	PermProjectsRead, PermProjectsWrite, PermProjectsDelete,
	PermUsersManage, PermTenantsManage, PermTenantsAccessAll,
}

// matrix is the permission matrix. Change it here and in matrix_test.go.
var matrix = map[Role][]Permission{
	RoleAdmin: Permissions,
	RoleTenantAdmin: {
		PermCatalogRead,
		PermProjectsRead, PermProjectsWrite, PermProjectsDelete,
		PermUsersManage,
	},
	RoleUser: {
		PermCatalogRead,
		PermProjectsRead, PermProjectsWrite,
	},
}

func (r Role) Valid() bool { return slices.Contains(Roles, r) }

// rank orders roles; higher is more powerful, 0 is unknown.
func (r Role) rank() int {
	if i := slices.Index(Roles, r); i >= 0 {
		return len(Roles) - i
	}
	return 0
}

func (r Role) Can(p Permission) bool { return slices.Contains(matrix[r], p) }

// Permissions returns the role's permissions in display order.
func (r Role) Permissions() []Permission {
	out := []Permission{}
	for _, p := range Permissions {
		if r.Can(p) {
			out = append(out, p)
		}
	}
	return out
}

// Actor is the authenticated caller of an operation.
type Actor struct {
	UserID    uuid.UUID
	TenantID  uuid.UUID
	SessionID uuid.UUID
	Role      Role
}

func (a Actor) Can(p Permission) bool { return a.Role.Can(p) }

// CanAssign reports whether the actor may give role r to someone. Nobody can
// grant a role above their own.
func (a Actor) CanAssign(r Role) bool { return r.Valid() && r.rank() <= a.Role.rank() }

// AssignableRoles lists the roles the actor may assign, highest first.
func (a Actor) AssignableRoles() []Role {
	out := []Role{}
	for _, r := range Roles {
		if a.CanAssign(r) {
			out = append(out, r)
		}
	}
	return out
}

// CanManage reports whether the actor may change a user with role r. Nobody
// can change a user whose role is above their own.
func (a Actor) CanManage(r Role) bool { return r.rank() <= a.Role.rank() }

// SeesTenant reports whether the actor may access data of tenant id.
func (a Actor) SeesTenant(id uuid.UUID) bool {
	return a.TenantID == id || a.Can(PermTenantsAccessAll)
}

// Actions tells the client which row actions the caller may perform, so the
// UI never re-implements the rules.
type Actions struct {
	Update bool `json:"update"`
	Delete bool `json:"delete"`
}

type ctxKey struct{}

func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, ctxKey{}, a)
}

func FromContext(ctx context.Context) (Actor, bool) {
	a, ok := ctx.Value(ctxKey{}).(Actor)
	return a, ok
}

// Require returns the actor if they are logged in and hold every permission.
func Require(ctx context.Context, perms ...Permission) (Actor, error) {
	a, ok := FromContext(ctx)
	if !ok {
		return Actor{}, ErrUnauthenticated()
	}
	for _, p := range perms {
		if !a.Can(p) {
			return Actor{}, apperr.New(http.StatusForbidden, "auth.forbidden", "missing permission").With("permission", string(p))
		}
	}
	return a, nil
}

func ErrUnauthenticated() *apperr.Error {
	return apperr.New(http.StatusUnauthorized, "auth.required", "login required")
}
