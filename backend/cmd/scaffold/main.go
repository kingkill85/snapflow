// Command scaffold creates a new feature in backend and frontend and wires it in.
//
//	go run ./cmd/scaffold product_types
//
// The name is the snake_case plural table name. The generated feature is a
// working CRUD for a translatable name; extend it from there. Run
// `make generate` afterwards (the Makefile's `feature` target does both).
// It must run from the backend directory.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl
var templates embed.FS

type names struct {
	Table       string // product_types
	Singular    string // product_type (error code prefix)
	Pkg         string // producttypes
	Type        string // ProductType
	Plural      string // ProductTypes
	URL         string // product-types (API path, frontend folder, OpenAPI tag)
	NS          string // productTypes (i18n namespace)
	Lower       string // product type
	LowerPlural string // product types
}

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*s$`)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "scaffold:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 1 || !namePattern.MatchString(args[0]) {
		return errors.New("usage: scaffold <snake_case_plural>, e.g. product_types")
	}
	n := deriveNames(args[0])

	featureDir := filepath.Join("internal", "features", n.Pkg)
	if _, err := os.Stat(featureDir); err == nil {
		return fmt.Errorf("%s already exists", featureDir)
	}
	frontendDir := filepath.Join("..", "frontend", "src", "features", n.URL)

	migration, err := nextMigration(n.Table)
	if err != nil {
		return err
	}

	files := map[string]string{
		migration:                                            "migration.sql.tmpl",
		filepath.Join(featureDir, "queries.sql"):             "queries.sql.tmpl",
		filepath.Join(featureDir, "service.go"):              "service.go.tmpl",
		filepath.Join(featureDir, "api.go"):                  "api.go.tmpl",
		filepath.Join(featureDir, "api_test.go"):             "api_test.go.tmpl",
		filepath.Join(frontendDir, "index.ts"):               "fe_index.ts.tmpl",
		filepath.Join(frontendDir, n.Plural+"Page.tsx"):      "fe_page.tsx.tmpl",
		filepath.Join(frontendDir, n.Plural+"Page.test.tsx"): "fe_page.test.tsx.tmpl",
		filepath.Join(frontendDir, n.Type+"FormDialog.tsx"):  "fe_form.tsx.tmpl",
	}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if err := render(path, files[path], n); err != nil {
			return err
		}
	}

	if err := writeLocales(frontendDir, n); err != nil {
		return err
	}
	return wire(n)
}

func deriveNames(table string) names {
	singular := strings.TrimSuffix(table, "s")
	if strings.HasSuffix(table, "ies") {
		singular = strings.TrimSuffix(table, "ies") + "y"
	}
	lower := strings.ReplaceAll(singular, "_", " ")
	return names{
		Table:       table,
		Singular:    singular,
		Pkg:         strings.ReplaceAll(table, "_", ""),
		Type:        camel(singular, true),
		Plural:      camel(table, true),
		URL:         strings.ReplaceAll(table, "_", "-"),
		NS:          camel(table, false),
		Lower:       lower,
		LowerPlural: strings.ReplaceAll(table, "_", " "),
	}
}

func camel(s string, upperFirst bool) string {
	parts := strings.Split(s, "_")
	for i, p := range parts {
		if i == 0 && !upperFirst {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, "")
}

func nextMigration(table string) (string, error) {
	entries, err := filepath.Glob(filepath.Join("migrations", "*.sql"))
	if err != nil {
		return "", err
	}
	next := 1
	for _, e := range entries {
		var num int
		if _, err := fmt.Sscanf(filepath.Base(e), "%05d_", &num); err == nil && num >= next {
			next = num + 1
		}
	}
	return filepath.Join("migrations", fmt.Sprintf("%05d_%s.sql", next, table)), nil
}

func render(path, tmpl string, n names) error {
	t, err := template.New(tmpl).Delims("[[", "]]").ParseFS(templates, "templates/"+tmpl)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	fmt.Println("create", path)
	return t.Execute(f, n)
}

func writeLocales(dir string, n names) error {
	title := strings.ToUpper(n.LowerPlural[:1]) + n.LowerPlural[1:]
	label := strings.ToUpper(n.Lower[:1]) + n.Lower[1:]
	locales := map[string]map[string]any{
		"en": {
			"title":         title,
			"empty":         "No " + n.LowerPlural + " yet.",
			"new":           "New " + n.Lower,
			"edit":          "Edit " + n.Lower,
			"deleteTitle":   "Delete " + n.Lower,
			"deleteMessage": `Delete "{{name}}"? This cannot be undone.`,
			"field":         map[string]string{"name": "Name"},
		},
		// German starts as English with a TODO marker; translate before release.
		"de": {
			"title":         "TODO " + title,
			"empty":         "TODO No " + n.LowerPlural + " yet.",
			"new":           "TODO New " + n.Lower,
			"edit":          "TODO Edit " + n.Lower,
			"deleteTitle":   "TODO Delete " + n.Lower,
			"deleteMessage": `"{{name}}" löschen? Das kann nicht rückgängig gemacht werden.`,
			"field":         map[string]string{"name": "Name"},
		},
	}
	for lang, content := range locales {
		if err := writeJSON(filepath.Join(dir, "locales", lang+".json"), content); err != nil {
			return err
		}
	}

	notFound := map[string]string{
		"en": "This " + label + " no longer exists.",
		"de": "TODO This " + n.Lower + " no longer exists.",
	}
	for lang, msg := range notFound {
		path := filepath.Join("..", "frontend", "src", "locales", lang, "errors.json")
		var errs map[string]any
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &errs); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		errs[n.Singular] = map[string]string{"not_found": msg}
		if err := writeJSON(path, errs); err != nil {
			return err
		}
	}
	return nil
}

func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println("write ", path)
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// wire inserts the new feature above each "scaffold:" marker.
func wire(n names) error {
	mod := "github.com/kingkill85/snapflow/backend/internal/features/" + n.Pkg
	edits := []struct{ path, marker, text string }{
		{"sqlc.yaml", "      # scaffold:overrides", fmt.Sprintf(
			"      - column: %s.name\n        go_type:\n          import: github.com/kingkill85/snapflow/backend/internal/platform/i18n\n          type: Text\n", n.Table)},
		{"sqlc.yaml", "  # scaffold:sqlc", fmt.Sprintf(
			"  - engine: postgresql\n    schema: migrations\n    queries: internal/features/%s/queries.sql\n    gen:\n      go:\n        <<: *go\n        out: internal/features/%s/store\n", n.Pkg, n.Pkg)},
		{filepath.Join("internal", "app", "features.go"), "\t// scaffold:imports", fmt.Sprintf(
			"\t%q\n\t%sstore %q\n", mod, n.Pkg, mod+"/store")},
		{filepath.Join("internal", "app", "features.go"), "\t// scaffold:features", fmt.Sprintf(
			"\t%s.Register(api, %s.NewService(%sstore.New(deps.DB)))\n", n.Pkg, n.Pkg, n.Pkg)},
		{filepath.Join("..", "frontend", "src", "app", "features.ts"), "// scaffold:imports", fmt.Sprintf(
			"import { %sFeature } from '@/features/%s'\n", n.NS, n.URL)},
		{filepath.Join("..", "frontend", "src", "app", "features.ts"), "  // scaffold:features", fmt.Sprintf(
			"  %sFeature,\n", n.NS)},
		{filepath.Join("..", "frontend", "src", "i18n", "resources.ts"), "// scaffold:imports", fmt.Sprintf(
			"import %sDe from '@/features/%s/locales/de.json'\nimport %sEn from '@/features/%s/locales/en.json'\n", n.NS, n.URL, n.NS, n.URL)},
		{filepath.Join("..", "frontend", "src", "i18n", "resources.ts"), "    // scaffold:i18n-en", fmt.Sprintf(
			"    %s: %sEn,\n", n.NS, n.NS)},
		{filepath.Join("..", "frontend", "src", "i18n", "resources.ts"), "    // scaffold:i18n-de", fmt.Sprintf(
			"    %s: %sDe,\n", n.NS, n.NS)},
	}
	for _, e := range edits {
		raw, err := os.ReadFile(e.path)
		if err != nil {
			return err
		}
		s := string(raw)
		if !strings.Contains(s, e.marker) {
			return fmt.Errorf("%s: marker %q not found", e.path, strings.TrimSpace(e.marker))
		}
		out := []byte(strings.Replace(s, e.marker, e.text+e.marker, 1))
		if strings.HasSuffix(e.path, ".go") {
			// gofmt sorts the imports the new feature was inserted into.
			if out, err = format.Source(out); err != nil {
				return fmt.Errorf("%s: %w", e.path, err)
			}
		}
		if err := os.WriteFile(e.path, out, 0o644); err != nil {
			return err
		}
		fmt.Println("wire  ", e.path)
	}
	return nil
}
