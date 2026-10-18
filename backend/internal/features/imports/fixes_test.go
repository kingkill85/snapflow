package imports_test

import (
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

func issueCodes(list []imports.ImportIssue) []string {
	out := []string{}
	for _, is := range list {
		out = append(out, strconv.Itoa(is.Row)+" "+is.Severity+" "+is.Code)
	}
	return out
}

// A mapped attribute the row's category lacks is an error only for a
// value: a blank cell is nothing to import (a constant always counts).
func TestUnknownAttribute(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	dims := map[string]any{"target": "attribute.dimensions", "column": "Dimensions"}
	weight := map[string]any{"target": "attribute.weight", "column": "Weight"}
	run := upload(t, api, "d.csv", csvFile("Model;Name;Variant;Price;Weight;Dimensions", "D-1;Dimmer;;5;;", "D-2;Dimmer 2;;5;3;4*4"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, weight, dims)})
	// Sorted by key: dimensions before weight, on every preview.
	got := []string{}
	for _, is := range issues(t, api, run.ID.String()) {
		got = append(got, strconv.Itoa(is.Row)+" "+is.Target+" "+is.Code)
	}
	if want := []string{"3 attribute.dimensions attribute.unknown", "3 attribute.weight attribute.unknown"}; !reflect.DeepEqual(got, want) {
		t.Errorf("issues %v", got)
	}
	constant := map[string]any{"target": "attribute.dimensions", "value": ""}
	run = upload(t, api, "e.csv", csvFile("Model;Name;Variant;Price", "E-1;E;;5"), "")
	if run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, constant)}); run.Counts.Errors != 1 {
		t.Errorf("constant: %d errors", run.Counts.Errors)
	}
}

// A catalog variant named "Standard" is found by its model number alone
// (D128), like one in the file.
func TestStandardAddonInCatalog(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	frames := newCategory(t, api, "frames", "", nil)
	run := upload(t, api, "f.csv", csvFile("Model;Name;Variant;Price", "F-9;Frame;;1"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, frames.ID)})
	apply(t, api, run.ID.String(), nil)

	run = upload(t, api, "d.csv", csvFile("Model;Name;Variant;Price;Addon", "D-1;Dimmer;;5;f-9"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, addonField)})
	if run.Counts.Addons.New != 1 || run.Counts.Warnings != 0 {
		t.Fatalf("counts %+v, issues %v", run.Counts, issueCodes(issues(t, api, run.ID.String())))
	}
	apply(t, api, run.ID.String(), nil)
	if a := catalog(t, api)["D-1"].Variants[0].Addons; len(a) != 1 || a[0].ModelNumber != "F-9" {
		t.Errorf("add-ons %+v", a)
	}
}

// A reference that two variants answer to is a warning; it links the
// first.
func TestAmbiguousAddon(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	// P-1's SKU is Q-1's model number and variant name.
	run := upload(t, api, "d.csv", csvFile("Model;Name;Variant;SKU;Price;Addon", "P-1;P;;Q-1 X;1;", "Q-1;Q;X;;1;", "D-1;D;;;1;q-1 x"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField, addonField)})
	if got := issueCodes(issues(t, api, run.ID.String())); !reflect.DeepEqual(got, []string{"4 warning import.addon_ambiguous"}) || run.Counts.Addons.New != 1 {
		t.Errorf("issues %v, counts %+v", got, run.Counts.Addons)
	}
}

// Without all or nothing: a unit whose write fails is reported at every one
// of its rows, and a link to one of its new variants is left out with a
// warning on the referencing row (counted as unresolved).
func TestSkippedUnitAndItsLinks(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	data := csvFile("Model;Name;Variant;SKU;Price;Addon", "D-1;Dimmer;;D1;5;F1B", "F-1;Frame;A;F1A;1;", "F-1;Frame;B;F1B;1;")
	run := upload(t, api, "d.csv", data, "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField, addonField)})
	if run.Counts.Addons.New != 1 {
		t.Fatalf("counts %+v", run.Counts.Addons)
	}
	defer imports.SetFailHook(func(it imports.ImportItem) error {
		if it.ModelNumber == "F-1" && it.Entity == "variant" && it.SKU == "F1B" {
			return apperr.New(http.StatusUnprocessableEntity, "variant.price_format", "injected")
		}
		return nil
	})()
	run = apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	if run.Applied.Addons.Unresolved != 1 || run.Applied.Addons.New != 0 || run.Applied.Errors != 1 {
		t.Errorf("applied %+v errors %d", run.Applied.Addons, run.Applied.Errors)
	}
	got := issueCodes(issues(t, api, run.ID.String()))
	want := []string{"3 error variant.price_format", "4 error variant.price_format", "2 warning import.addon_skipped"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("issues %v", got)
	}
	c := catalog(t, api)
	if _, ok := c["F-1"]; ok || len(c["D-1"].Variants[0].Addons) != 0 {
		t.Errorf("catalog %+v", c)
	}
}

// Prices with more than two decimals from cells (computed in the
// spreadsheet) are rounded to the cent, half up, with a warning.
func TestPriceRounding(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	run := upload(t, api, "d.csv", csvFile("Model;Name;Variant;Price", "D-1;D;;32,725", "D-2;D;;1.004", "D-3;D;;abc"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID)})
	list := issues(t, api, run.ID.String())
	if got := issueCodes(list); !reflect.DeepEqual(got, []string{"2 warning import.price_rounded", "3 warning import.price_rounded", "4 error variant.price_format"}) {
		t.Fatalf("issues %v", got)
	}
	if list[0].Params["value"] != "32,725" || list[0].Params["rounded"] != "32.73" {
		t.Errorf("params %v", list[0].Params)
	}
	apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	c := catalog(t, api)
	if c["D-1"].Variants[0].Price != "32.73" || c["D-2"].Variants[0].Price != "1.00" {
		t.Errorf("prices %s %s", c["D-1"].Variants[0].Price, c["D-2"].Variants[0].Price)
	}
}

// A CSV with a title line: the delimiter comes from the header row.
func TestCSVTitleLine(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	run := upload(t, api, "d.csv", []byte("Preisliste Zigbee, Stand 2026\n\nModel;Name;Variant;Price\nM-1;Dimmer, white;;1,50\n"), "")
	src := decode[imports.ImportSourcePreview](t, api.Get("/api/imports/"+run.ID.String()+"/source?headerRow=3", api.Admin.Cookie))
	if len(src.Columns) != 4 || src.Columns[1].Header != "Name" || src.Rows[0].Cells[1] != "Dimmer, white" {
		t.Fatalf("source %+v", src)
	}
	m := csvMapping(pt.ID, cat.ID)
	m["headerRow"], m["dataStartRow"] = 3, 4
	if run = preview(t, api, run.ID.String(), map[string]any{"mapping": m}); run.Counts.Errors != 0 || run.Counts.Products.New != 1 {
		t.Errorf("counts %+v", run.Counts)
	}
}

// Runs can be deleted unless applied (undo first); the file stays.
func TestDeleteRun(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	uploaded := upload(t, api, "a.csv", csvFile("Model;Name;Variant;Price", "D-1;D;;1"), "")
	expect(t, api.Delete("/api/imports/"+uploaded.ID.String(), api.Admin.Cookie), http.StatusNoContent)
	assertError(t, api.Get("/api/imports/"+uploaded.ID.String(), api.Admin.Cookie), http.StatusNotFound, "import.not_found")
	assertError(t, api.Delete("/api/imports/"+uploaded.ID.String(), api.Admin.Cookie), http.StatusNotFound, "import.not_found")
	expect(t, api.Get("/api/files/"+uploaded.FileID.String(), api.Admin.Cookie), http.StatusOK)

	run := upload(t, api, "b.csv", csvFile("Model;Name;Variant;Price", "D-1;D;;1"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID)})
	apply(t, api, run.ID.String(), nil)
	assertError(t, api.Delete("/api/imports/"+run.ID.String(), api.Admin.Cookie), http.StatusConflict, "import.state")
	undo(t, api, run.ID.String())
	expect(t, api.Delete("/api/imports/"+run.ID.String(), api.Admin.Cookie), http.StatusNoContent)
}

// The diff can be narrowed to changes, searched and filtered by row; every
// row issue names the diff item of its row.
func TestItemsSearchAndIssueLinks(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	first := upload(t, api, "a.csv", csvFile("Model;Name;Variant;SKU;Price", "D-1;Dimmer;White;D1W;1", "D-1;Dimmer;Black;D1B;1"), "")
	preview(t, api, first.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField)})
	apply(t, api, first.ID.String(), nil)
	run := upload(t, api, "b.csv", csvFile("Model;Name;Variant;SKU;Price", "D-1;Dimmer;White;D1W;2", "D-1;Dimmer;Black;D1B;1", "E-1;Encoder;;E1;x"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField)})
	labels := func(query string) []string {
		out := []string{}
		for _, it := range items(t, api, run.ID.String(), query) {
			out = append(out, it.Entity+" "+it.ModelNumber+" "+it.Name["en"])
		}
		return out
	}
	for query, want := range map[string][]string{
		"changedOnly=true":           {"variant D-1 White", "product E-1 Encoder", "variant E-1 Standard"},
		"search=d1b":                 {"variant D-1 Black"},
		"search=encod":               {"product E-1 Encoder"},
		"search=3":                   {"product D-1 Dimmer", "variant D-1 Black"},
		"row=4":                      {"product E-1 Encoder", "variant E-1 Standard"},
		"search=%25":                 {},
		"changedOnly=true&row=2":     {"variant D-1 White"},
		"entity=product&search=dimm": {"product D-1 Dimmer"},
	} {
		if got := labels(query); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", query, got, want)
		}
	}
	list := issues(t, api, run.ID.String())
	if len(list) != 1 || list[0].Row != 4 || list[0].ModelNumber != "E-1" {
		t.Fatalf("issues %+v", list)
	}
	linked := items(t, api, run.ID.String(), "row=4&entity=variant")
	if len(linked) != 1 || linked[0].Seq != list[0].ItemSeq {
		t.Errorf("issue item %d, items %+v", list[0].ItemSeq, linked)
	}
}

// Undo restores an SKU the run changed; if another variant has taken it
// since, that is a conflict naming that variant, not variant.sku_taken.
func TestUndoRestoredSKUTaken(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	m := csvMapping(pt.ID, cat.ID, skuField)
	first := upload(t, api, "a.csv", csvFile("Model;Name;Variant;SKU;Price", "D-1;D;White;S-1;1"), "")
	preview(t, api, first.ID.String(), map[string]any{"mapping": m})
	apply(t, api, first.ID.String(), nil)
	second := upload(t, api, "b.csv", csvFile("Model;Name;Variant;SKU;Price", "D-1;D;White;S-2;1"), "")
	preview(t, api, second.ID.String(), map[string]any{"mapping": m})
	apply(t, api, second.ID.String(), nil)
	other := newProduct(t, api, pt.ID, newCategory(t, api, "other", "", nil).ID, "O-1")
	taker := newVariant(t, api, other.ID, "Standard", "s-1")

	p := assertError(t, api.Post("/api/imports/"+second.ID.String()+"/undo", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.undo_conflict")
	entities := p.Params["entities"].([]any)
	if len(entities) != 1 || entities[0].(map[string]any)["id"] != taker.ID || entities[0].(map[string]any)["productId"] != other.ID {
		t.Errorf("conflicts %v", p.Params)
	}
}

// Reading runs, their source, diff, issues and change log, deleting runs
// and the profile endpoints need catalog.write; uploads are refused before
// the body is read.
func TestPermissionsAll(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	run := upload(t, api, "a.csv", csvFile("Model;Name;Variant;Price", "D-1;D;;1"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID)})
	profile := decode[[]imports.ImportProfile](t, api.Get("/api/import-profiles", api.Admin.Cookie))[0]
	id := run.ID.String()
	big := make([]byte, imports.MaxFileSize+1<<20)
	tenant := api.NewTenant("Partner")
	for _, s := range []apptest.Session{api.NewUser(tenant, auth.RoleUser), api.NewUser(tenant, auth.RoleTenantAdmin)} {
		for name, resp := range map[string]interface{ Result() *http.Response }{
			"source":         api.Get("/api/imports/"+id+"/source", s.Cookie),
			"items":          api.Get("/api/imports/"+id+"/items", s.Cookie),
			"issues":         api.Get("/api/imports/"+id+"/issues", s.Cookie),
			"changes":        api.Get("/api/imports/"+id+"/changes", s.Cookie),
			"delete":         api.Delete("/api/imports/"+id, s.Cookie),
			"profile":        api.Get("/api/import-profiles/"+profile.ID.String(), s.Cookie),
			"update profile": api.Put("/api/import-profiles/"+profile.ID.String(), s.Cookie, map[string]any{"name": "x", "mapping": profile.Mapping, "expectedUpdatedAt": profile.UpdatedAt}),
			"delete profile": api.Delete("/api/import-profiles/"+profile.ID.String(), s.Cookie),
			"big upload":     uploadRaw(api, s.Cookie, "a.csv", big),
		} {
			if code := resp.Result().StatusCode; code != http.StatusForbidden {
				t.Errorf("%s %s: got %d", s.Email, name, code)
			}
		}
	}
	if code := uploadRaw(api, "", "a.csv", big).Code; code != http.StatusUnauthorized {
		t.Errorf("anonymous big upload: got %d", code)
	}
	if r := decode[imports.ImportRun](t, api.Get("/api/imports/"+id, api.Admin.Cookie)); r.State != imports.StatePreviewed {
		t.Errorf("run %s", r.State)
	}
}
