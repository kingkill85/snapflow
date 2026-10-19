package imports_test

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

func statuses(cols []imports.ImportColumn) []string {
	out := []string{}
	for _, c := range cols {
		s := c.Target + " " + c.Status
		if c.Field != nil {
			s += " " + c.Field.Key
		}
		out = append(out, s)
	}
	return out
}

// D188: attribute columns are matched against the catalog fields; unknown
// ones block the preview until they are answered (a new field, or just
// information); categories the import creates link their attributes to the
// fields; the profile keeps the answers.
func TestUnknownColumns(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	relay := decode[capabilities.OutputKind](t, api.Post("/api/output-kinds", api.Admin.Cookie,
		map[string]any{"key": "relay_output", "name": map[string]string{"en": "Relay output"}, "isActive": true}))
	expect(t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "relay_outputs", "label": map[string]string{"en": "Relay outputs"},
		"type": "integer", "meaning": "channels_supplied", "outputKindId": relay.ID}), http.StatusCreated)
	// Matched by label: the header "Width (TE)" is the field "Module width".
	expect(t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "module_width", "label": map[string]string{"en": "Width (TE)"},
		"type": "number", "unit": "TE", "meaning": "rail_width_te"}), http.StatusCreated)
	data := csvFile(
		"Model;Category;Name;Price;Relays;Width (TE);Bus current (mA);Notes;Mounting",
		"R-8;Switch actuators;Relay 8;100;8;4;12;din rail;Verteiler",
		"R-4;Switch actuators;Relay 4;60;4;2;;;",
	)
	mapping := map[string]any{"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "productTypeId": pt.ID, "createMissingCategories": true,
		"fields": []any{
			map[string]any{"target": "product.modelNumber", "column": "Model"},
			map[string]any{"target": "product.category", "column": "Category"},
			map[string]any{"target": "product.name.en", "column": "Name"},
			map[string]any{"target": "variant.price", "column": "Price"},
			map[string]any{"target": "attribute.relay_outputs", "column": "Relays"},
			map[string]any{"target": "attribute.width", "column": "Width (TE)"},
			map[string]any{"target": "attribute.bus_current", "column": "Bus current (mA)"},
			map[string]any{"target": "attribute.notes", "column": "Notes"},
			map[string]any{"target": "product.mounting", "column": "Mounting"},
		}}
	check := decode[imports.ImportColumns](t, api.Post("/api/import-columns", api.Admin.Cookie, map[string]any{"mapping": mapping}))
	want := []string{"attribute.relay_outputs field relay_outputs", "attribute.width field module_width",
		"attribute.bus_current unknown", "attribute.notes unknown"}
	if got := statuses(check.Columns); !reflect.DeepEqual(got, want) || check.Unknown != 2 || check.Mapping.Fields[4].FieldKey != "relay_outputs" {
		t.Errorf("columns %v (%d)", got, check.Unknown)
	}
	run := upload(t, api, "r.csv", data, "")
	p := assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"mapping": mapping}),
		http.StatusUnprocessableEntity, "import.columns_unknown")
	if p.Params["columns"] != "attribute.bus_current, attribute.notes" || p.Params["count"] != 2.0 {
		t.Errorf("params %v", p.Params)
	}

	// Answers: checked together, nothing created on errors.
	busField := map[string]any{"key": "bus_current_ma", "label": map[string]string{"en": "Bus current", "de": "Busstrom"}, "type": "number",
		"unit": "mA", "meaning": "bus_current_used_ma"}
	p = assertError(t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping, "answers": []any{
		map[string]any{"target": "attribute.bus_current", "field": map[string]any{"key": "x", "label": map[string]string{"en": "X"},
			"type": "number", "meaning": "channels_supplied"}},
		map[string]any{"target": "attribute.notes"},
		map[string]any{"target": "attribute.nope", "information": true},
	}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.answers[1] import.answer_required", "body.answers[2].target import.answer_target"}) {
		t.Errorf("answers %v", got)
	}
	p = assertError(t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping, "answers": []any{
		map[string]any{"target": "attribute.notes", "information": true},
		map[string]any{"target": "attribute.bus_current", "field": map[string]any{"key": "relay_outputs", "label": map[string]string{"en": "X"},
			"type": "integer", "meaning": "channels_supplied"}},
	}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.answers[1].field.outputKindId validation.required",
		"body.answers[1].field.key catalog_field.key_taken"}) {
		t.Errorf("field answers %v", got)
	}
	answered := decode[imports.ImportColumns](t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping, "answers": []any{
		map[string]any{"target": "attribute.bus_current", "field": busField},
		map[string]any{"target": "attribute.notes", "information": true},
	}}))
	want = []string{"attribute.relay_outputs field relay_outputs", "attribute.width field module_width",
		"attribute.bus_current field bus_current_ma", "attribute.notes information"}
	if got := statuses(answered.Columns); !reflect.DeepEqual(got, want) || answered.Unknown != 0 {
		t.Errorf("answered %v", got)
	}

	// The answered mapping previews; the created category links the fields.
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": answered.Mapping})
	if run.Counts.Errors != 0 || run.Counts.Categories.New != 1 || run.Counts.Products.New != 2 {
		t.Fatalf("counts %+v %+v", run.Counts, issues(t, api, run.ID.String()))
	}
	apply(t, api, run.ID.String(), nil)
	sw := categoryList(t, api)["switch_actuators"]
	links := map[string]string{}
	for _, a := range sw.Attributes {
		fk, _ := a["fieldKey"].(string)
		links[a["key"].(string)] = fk + " " + a["type"].(string)
	}
	if !reflect.DeepEqual(links, map[string]string{"relay_outputs": "relay_outputs integer", "width": "module_width number",
		"bus_current": "bus_current_ma number", "notes": " text"}) {
		t.Errorf("created category %v", links)
	}
	cat := catalog(t, api)
	got := decode[products.Product](t, api.Get("/api/products/"+cat["R-8"].ID, api.Admin.Cookie))
	c := got.Capabilities
	if got.Mounting != "board" || c.Mounting != "board" || len(c.Channels) != 1 || c.Channels[0].Count != 8 ||
		c.BusCurrentUsedMa == nil || *c.BusCurrentUsedMa != 12 || *c.RailWidthTE != 4 {
		t.Errorf("R-8 %+v", c)
	}
	if r4 := decode[products.Product](t, api.Get("/api/products/"+cat["R-4"].ID, api.Admin.Cookie)); r4.Mounting != "" ||
		r4.Capabilities.Mounting != "floorplan" || r4.Capabilities.BusCurrentUsedMa != nil {
		t.Errorf("R-4 %+v", r4.Capabilities)
	}

	// A profile keeps the answers: the next file previews without asking.
	resp := api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "Relays", "mapping": answered.Mapping})
	expect(t, resp, http.StatusCreated)
	profile := decode[imports.ImportProfile](t, resp)
	if profile.Mapping.Fields[7].Information != true || profile.Mapping.Fields[6].FieldKey != "bus_current_ma" {
		t.Errorf("profile %+v", profile.Mapping.Fields)
	}
	again := upload(t, api, "r.csv", data, profile.ID.String())
	if again.Counts.Products.Unchanged != 2 || again.Counts.Errors != 0 {
		t.Errorf("again %+v", again.Counts)
	}

	// An unknown mounting value is a row error.
	bad := upload(t, api, "b.csv", csvFile("Model;Category;Name;Price;Relays;Width (TE);Bus current (mA);Notes;Mounting",
		"R-8;Switch actuators;Relay 8;100;8;4;12;;roof"), profile.ID.String())
	if is := issues(t, api, bad.ID.String()); len(is) != 1 || is[0].Code != "import.mounting_unknown" || is[0].Params["value"] != "roof" {
		t.Errorf("issues %+v", is)
	}

	// Permissions: catalog.write.
	user := api.NewUser(api.NewTenant("Partner"), auth.RoleUser)
	assertError(t, api.Post("/api/import-columns", user.Cookie, map[string]any{"mapping": mapping}), http.StatusForbidden, "auth.forbidden")
}
