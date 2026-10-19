package installation_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// fileExists reports whether a document's file row and contents exist.
func fileExists(t *testing.T, w world, id, sum string) bool {
	t.Helper()
	var row bool
	if err := w.api.DB.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM files WHERE id = $1)`, id).Scan(&row); err != nil {
		t.Fatal(err)
	}
	_, err := os.Stat(filepath.Join(w.api.StorageDir, sum[0:2], sum[2:4], sum))
	if row != (err == nil) {
		t.Errorf("file %s: row %v, contents %v", id, row, err == nil)
	}
	return row
}

func docFile(t *testing.T, w world, docID uuid.UUID) (string, string) {
	t.Helper()
	var id, sum string
	err := database.InAllTenants(t.Context(), w.api.DB, pgx.TxOptions{}, func(tx pgx.Tx) error {
		return tx.QueryRow(t.Context(), `SELECT f.id::text, f.sha256 FROM generated_documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1`, docID).
			Scan(&id, &sum)
	})
	if err != nil {
		t.Fatal(err)
	}
	return id, sum
}

// D269: deleting a document or its version deletes the document's file.
func TestDocumentFiles(t *testing.T) {
	w := setup(t, "en")
	admin := w.api.NewUser(w.user.TenantID, auth.RoleTenantAdmin)
	doc, _ := generate(t, w, "channel_labels")
	id, sum := docFile(t, w, doc.ID)
	if !fileExists(t, w, id, sum) {
		t.Fatal("not stored")
	}
	want(t, w.api.Delete("/api/documents/"+doc.ID.String(), admin.Cookie), http.StatusNoContent, "")
	if fileExists(t, w, id, sum) {
		t.Error("document delete kept the file")
	}

	// A second version with a document; deleting the version deletes it.
	resp := w.api.Post("/api/projects/"+w.project.String()+"/versions", w.user.Cookie, map[string]any{"sourceVersionId": w.version, "name": "V2"})
	want(t, resp, http.StatusCreated, "")
	v2 := decode[struct{ ID uuid.UUID }](t, resp).ID
	resp = w.api.Post("/api/versions/"+v2.String()+"/documents", w.user.Cookie, map[string]any{"kind": "channel_labels"})
	want(t, resp, http.StatusCreated, "")
	doc2 := decode[struct{ ID uuid.UUID }](t, resp).ID
	id, sum = docFile(t, w, doc2)
	want(t, w.api.Delete("/api/projects/"+w.project.String()+"/versions/"+v2.String(), admin.Cookie), http.StatusNoContent, "")
	if fileExists(t, w, id, sum) {
		t.Error("version delete kept the file")
	}
}
