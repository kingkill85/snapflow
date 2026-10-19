package proposals_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// storedFile is a proposal's file as the database and the disk have it.
type storedFile struct {
	id  uuid.UUID
	sum string
}

func fileOf(t *testing.T, api *apptest.API, p proposals.Proposal) storedFile {
	t.Helper()
	var f storedFile
	err := database.InAllTenants(t.Context(), api.DB, pgx.TxOptions{}, func(tx pgx.Tx) error {
		return tx.QueryRow(t.Context(), `SELECT f.id, f.sha256 FROM proposals p JOIN files f ON f.id = p.file_id WHERE p.id = $1`, p.ID).
			Scan(&f.id, &f.sum)
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// exists reports whether the file's row and its contents on disk exist.
func exists(t *testing.T, api *apptest.API, f storedFile) (row, contents bool) {
	t.Helper()
	if err := api.DB.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM files WHERE id = $1)`, f.id).Scan(&row); err != nil {
		t.Fatal(err)
	}
	_, err := os.Stat(filepath.Join(api.StorageDir, f.sum[0:2], f.sum[2:4], f.sum))
	return row, err == nil
}

func wantFile(t *testing.T, api *apptest.API, f storedFile, want bool, what string) {
	t.Helper()
	if row, contents := exists(t, api, f); row != want || contents != want {
		t.Errorf("%s: file row %v, contents %v, want %v", what, row, contents, want)
	}
}

func generateOne(t *testing.T, api *apptest.API, cookie string, versionID uuid.UUID) proposals.Proposal {
	t.Helper()
	resp := generate(api, cookie, versionID, map[string]any{"exporter": "docx"})
	wantCode(t, resp, http.StatusCreated, "")
	return decode[[]proposals.Proposal](t, resp)[0]
}

// D269: deleting a proposal, its version or its project deletes the
// proposal's file unless another row still references it.
func TestDeleteFiles(t *testing.T) {
	api := apptest.New(t)
	acme := api.NewTenant("Acme")
	user := api.NewUser(acme, auth.RoleUser)
	admin := api.NewUser(acme, auth.RoleTenantAdmin)
	f := setup(t, api, user.Cookie)

	kept := generateOne(t, api, user.Cookie, f.version)
	gone := generateOne(t, api, user.Cookie, f.version)
	keptFile, goneFile := fileOf(t, api, kept), fileOf(t, api, gone)
	wantFile(t, api, keptFile, true, "generated")

	// Another feature's row (the tenant's logo) references the first file.
	if _, err := api.DB.Exec(t.Context(), `UPDATE tenants SET logo_file_id = $1 WHERE id = $2`, keptFile.id, acme); err != nil {
		t.Fatal(err)
	}
	wantCode(t, api.Delete("/api/proposals/"+kept.ID.String(), admin.Cookie), http.StatusNoContent, "")
	wantFile(t, api, keptFile, true, "file referenced by the logo")
	wantCode(t, api.Delete("/api/proposals/"+gone.ID.String(), admin.Cookie), http.StatusNoContent, "")
	wantFile(t, api, goneFile, false, "deleted proposal")
	wantCode(t, api.Get("/api/files/"+goneFile.id.String(), api.Admin.Cookie), http.StatusNotFound, "file.not_found")

	// Two proposals sharing one file: the file stays until both are gone.
	first := generateOne(t, api, user.Cookie, f.version)
	second := generateOne(t, api, user.Cookie, f.version)
	shared := fileOf(t, api, first)
	err := database.InAllTenants(t.Context(), api.DB, pgx.TxOptions{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(t.Context(), `UPDATE proposals SET file_id = $1 WHERE id = $2`, shared.id, second.ID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	wantCode(t, api.Delete("/api/proposals/"+first.ID.String(), admin.Cookie), http.StatusNoContent, "")
	wantFile(t, api, shared, true, "file of another proposal")
	wantCode(t, api.Delete("/api/proposals/"+second.ID.String(), admin.Cookie), http.StatusNoContent, "")
	wantFile(t, api, shared, false, "file of both deleted proposals")

	// Version delete.
	resp := api.Post("/api/projects/"+f.project.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V2", "sourceVersionId": f.version})
	wantCode(t, resp, http.StatusCreated, "")
	v2 := decode[struct{ ID uuid.UUID }](t, resp).ID
	ofV2 := fileOf(t, api, generateOne(t, api, user.Cookie, v2))
	wantCode(t, api.Delete("/api/projects/"+f.project.ID.String()+"/versions/"+v2.String(), user.Cookie), http.StatusNoContent, "")
	wantFile(t, api, ofV2, false, "proposal of a deleted version")

	// Project delete; the logo stays.
	ofV1 := fileOf(t, api, generateOne(t, api, user.Cookie, f.version))
	wantCode(t, api.Delete("/api/projects/"+f.project.ID.String(), admin.Cookie), http.StatusNoContent, "")
	wantFile(t, api, ofV1, false, "proposal of a deleted project")
	wantFile(t, api, keptFile, true, "logo after the project delete")
}
