package auth

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// The permission matrix, spelled out. A change to the matrix must change this
// table too, so it never happens by accident.
func TestMatrix(t *testing.T) {
	want := map[Permission][3]bool{ // admin, tenant_admin, user
		PermCatalogRead:      {true, true, true},
		PermCatalogWrite:     {true, false, false},
		PermProjectsRead:     {true, true, true},
		PermProjectsWrite:    {true, true, true},
		PermProjectsDelete:   {true, true, false},
		PermUsersManage:      {true, true, false},
		PermTenantsManage:    {true, false, false},
		PermTenantsAccessAll: {true, false, false},
	}
	if len(want) != len(Permissions) {
		t.Fatalf("table covers %d permissions, matrix has %d", len(want), len(Permissions))
	}
	for p, roles := range want {
		for i, r := range Roles {
			if got := r.Can(p); got != roles[i] {
				t.Errorf("%s %s: got %v, want %v", r, p, got, roles[i])
			}
		}
	}
}

func TestRoleOrder(t *testing.T) {
	tenantAdmin := Actor{Role: RoleTenantAdmin}
	if tenantAdmin.CanAssign(RoleAdmin) || tenantAdmin.CanManage(RoleAdmin) {
		t.Error("tenant admin must not assign or manage admins")
	}
	if !tenantAdmin.CanAssign(RoleTenantAdmin) || !tenantAdmin.CanManage(RoleUser) {
		t.Error("tenant admin must assign and manage roles up to their own")
	}
	if got := tenantAdmin.AssignableRoles(); len(got) != 2 || got[0] != RoleTenantAdmin {
		t.Errorf("assignable roles: %v", got)
	}
	if (Actor{Role: RoleAdmin}).CanAssign("owner") {
		t.Error("unknown roles are never assignable")
	}
}

func TestSeesTenant(t *testing.T) {
	own, other := uuid.New(), uuid.New()
	if !(Actor{Role: RoleUser, TenantID: own}).SeesTenant(own) {
		t.Error("everyone sees their own tenant")
	}
	if (Actor{Role: RoleTenantAdmin, TenantID: own}).SeesTenant(other) {
		t.Error("tenant admin must not see other tenants")
	}
	if !(Actor{Role: RoleAdmin, TenantID: own}).SeesTenant(other) {
		t.Error("admin sees every tenant")
	}
}

func TestRequire(t *testing.T) {
	if _, err := Require(context.Background()); err == nil || err.(interface{ GetStatus() int }).GetStatus() != 401 {
		t.Errorf("anonymous: got %v", err)
	}
	ctx := WithActor(context.Background(), Actor{Role: RoleUser})
	if _, err := Require(ctx, PermCatalogRead); err != nil {
		t.Errorf("allowed: got %v", err)
	}
	if _, err := Require(ctx, PermCatalogWrite); err == nil || err.(interface{ GetStatus() int }).GetStatus() != 403 {
		t.Errorf("forbidden: got %v", err)
	}
}
