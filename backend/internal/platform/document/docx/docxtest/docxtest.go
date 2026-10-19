// Package docxtest converts generated DOCX files to PDF with LibreOffice in
// tests: the proof that a real word processor opens them.
package docxtest

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Soffice returns the soffice binary. Without one the test is skipped, or
// fails when REQUIRE_SOFFICE=1 (CI's documents job), so the check cannot
// silently stop running. KEEP_PDF=<dir> keeps the converted files there.
func Soffice(t *testing.T) string {
	t.Helper()
	soffice, err := exec.LookPath("soffice")
	if err != nil {
		if os.Getenv("REQUIRE_SOFFICE") == "1" {
			t.Fatal("soffice not found but REQUIRE_SOFFICE=1")
		}
		t.Skip("soffice not installed (nix develop .#documents)")
	}
	return soffice
}

// ConvertToPDF writes each file and converts it to PDF; every conversion must
// produce a non-empty PDF.
func ConvertToPDF(t *testing.T, soffice string, files map[string][]byte) {
	t.Helper()
	dir := t.TempDir()
	out := dir
	if keep := os.Getenv("KEEP_PDF"); keep != "" {
		out = keep
		if err := os.MkdirAll(out, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	args := []string{"--headless", "-env:UserInstallation=file://" + dir + "/profile", "--convert-to", "pdf", "--outdir", out}
	for name, data := range files {
		in := filepath.Join(out, name)
		if err := os.WriteFile(in, data, 0o600); err != nil {
			t.Fatal(err)
		}
		args = append(args, in)
	}
	cmd := exec.Command(soffice, args...)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("soffice: %v: %s", err, b)
	}
	for name := range files {
		pdf := filepath.Join(out, strings.TrimSuffix(name, filepath.Ext(name))+".pdf")
		if st, err := os.Stat(pdf); err != nil || st.Size() == 0 {
			t.Errorf("%s: no PDF (LibreOffice could not open it): %v", name, err)
		}
	}
}
