package files_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	filesstore "github.com/kingkill85/snapflow/backend/internal/features/files/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// D79: tenant files are deduplicated per scope and read only by their
// tenant and callers who see every tenant.
func TestScopes(t *testing.T) {
	api := apptest.New(t)
	storage, err := files.NewStorage(api.StorageDir)
	if err != nil {
		t.Fatal(err)
	}
	svc := files.NewService(filesstore.New(api.DB), storage)
	acme := api.NewTenant("Acme")
	other := api.NewTenant("Other")
	acmeUser := api.NewUser(acme, auth.RoleUser)
	otherUser := api.NewUser(other, auth.RoleUser)
	as := func(s apptest.Session, role auth.Role) context.Context {
		return auth.WithActor(t.Context(), auth.Actor{UserID: s.UserID, TenantID: s.TenantID, Role: role})
	}
	acmeCtx := as(acmeUser, auth.RoleUser)
	data := pngImage(t, 6, 4)

	catalog := mustUpload(t, api, data)
	tenantFile, err := svc.UploadBytes(acmeCtx, files.TenantScope(acme), data)
	if err != nil {
		t.Fatal(err)
	}
	if tenantFile.ID.String() == catalog.ID || tenantFile.TenantID == nil || *tenantFile.TenantID != acme {
		t.Errorf("tenant file: %+v (catalog %s)", tenantFile, catalog.ID)
	}
	// The same bytes again in the same scope: the same file.
	again, err := svc.UploadBytes(acmeCtx, files.TenantScope(acme), data)
	if err != nil || again.ID != tenantFile.ID {
		t.Errorf("dedup per scope: %v %v", again.ID, err)
	}
	doc, err := svc.StoreDocument(acmeCtx, files.TenantScope(acme), []byte("plan"), "application/pdf")
	if err != nil || doc.TenantID == nil {
		t.Errorf("document: %+v %v", doc, err)
	}

	// Storing in another tenant or in the catalog is refused.
	var ae *apperr.Error
	if _, err := svc.UploadBytes(acmeCtx, files.TenantScope(other), data); !errors.As(err, &ae) || ae.Code != "file.tenant_forbidden" {
		t.Errorf("foreign scope: %v", err)
	}
	if _, err := svc.UploadBytes(acmeCtx, files.Catalog, data); !errors.As(err, &ae) || ae.Code != "auth.forbidden" {
		t.Errorf("catalog by user: %v", err)
	}

	// Downloads: catalog for all; tenant files for the tenant and admins.
	url := "/api/files/" + tenantFile.ID.String()
	for name, c := range map[string]struct {
		cookie string
		want   int
	}{
		"own tenant":   {acmeUser.Cookie, http.StatusOK},
		"admin":        {api.Admin.Cookie, http.StatusOK},
		"other tenant": {otherUser.Cookie, http.StatusNotFound},
	} {
		if resp := api.Get(url, c.cookie); resp.Code != c.want {
			t.Errorf("%s: got %d", name, resp.Code)
		}
	}
	if resp := api.Get(catalog.URL, otherUser.Cookie); resp.Code != http.StatusOK {
		t.Errorf("catalog file: %d", resp.Code)
	}

	// Exists checks the scope.
	for name, c := range map[string]struct {
		ctx   context.Context
		scope files.Scope
		want  bool
	}{
		"own scope":        {acmeCtx, files.TenantScope(acme), true},
		"catalog scope":    {acmeCtx, files.Catalog, false},
		"foreign scope":    {as(otherUser, auth.RoleUser), files.TenantScope(other), false},
		"unseen own scope": {as(otherUser, auth.RoleUser), files.TenantScope(acme), false},
	} {
		if ok, err := svc.Exists(c.ctx, c.scope, tenantFile.ID); err != nil || ok != c.want {
			t.Errorf("%s: %v %v", name, ok, err)
		}
	}
}
