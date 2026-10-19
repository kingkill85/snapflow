package imports_test

import (
	"net/http"
	"reflect"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
)

func categoryStatuses(cols []imports.ImportColumn) map[string][]string {
	out := map[string][]string{}
	for _, c := range cols {
		list := []string{}
		for _, cc := range c.Categories {
			list = append(list, cc.Key+" "+cc.Status)
		}
		out[c.Key] = list
	}
	return out
}

// Existing categories: the column check reports the link status of the
// attributes the columns feed (only the fixed category when the mapping has
// one); the preview lists linking an unlinked attribute of the same type as
// a category change, warns about another type, and the apply links them.
// Answers may link an existing field (also overriding an automatic match).
// A linked field changed between preview and apply makes the preview stale.
func TestColumnsOfExistingCategories(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	width := decode[capabilities.CatalogField](t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "module_width",
		"label": map[string]string{"en": "Width (TE)"}, "type": "number", "unit": "TE", "meaning": "rail_width_te"}))
	expect(t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "bus_current",
		"label": map[string]string{"en": "Bus current"}, "type": "number", "meaning": "bus_current_used_ma"}), http.StatusCreated)
	expect(t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "remark",
		"label": map[string]string{"en": "Remark"}, "type": "text"}), http.StatusCreated)
	attr := func(key, typ string) map[string]any {
		return map[string]any{"key": key, "label": map[string]string{"en": key}, "type": typ, "scope": "product"}
	}
	act := newCategory(t, api, "actuators", "Actuators", []any{attr("width", "number"), attr("bus", "text"), attr("extra", "text")})
	newCategory(t, api, "other", "Other", []any{attr("notes", "text")})

	mapping := map[string]any{"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "productTypeId": pt.ID, "categoryId": act.ID,
		"fields": []any{
			map[string]any{"target": "product.modelNumber", "column": "Model"},
			map[string]any{"target": "product.name.en", "column": "Name"},
			map[string]any{"target": "attribute.width", "column": "Width (TE)"},
			map[string]any{"target": "attribute.bus", "column": "Bus current"},
			map[string]any{"target": "attribute.extra", "column": "Extra"},
			map[string]any{"target": "attribute.notes", "column": "Notes"},
			map[string]any{"target": "variant.price", "column": "Price"},
		}}
	check := decode[imports.ImportColumns](t, api.Post("/api/import-columns", api.Admin.Cookie, map[string]any{"mapping": mapping}))
	// With a fixed category only its attributes make a column known.
	want := []string{"attribute.width field module_width", "attribute.bus field bus_current", "attribute.extra category", "attribute.notes unknown"}
	if got := statuses(check.Columns); !reflect.DeepEqual(got, want) || check.Unknown != 1 {
		t.Errorf("columns %v", got)
	}
	if got := categoryStatuses(check.Columns); !reflect.DeepEqual(got, map[string][]string{"width": {"actuators will_link"},
		"bus": {"actuators type_mismatch"}, "extra": {"actuators unlinked"}, "notes": {}}) {
		t.Errorf("category statuses %v", got)
	}
	if check.Columns[2].FieldIndex != 4 {
		t.Errorf("fieldIndex %d", check.Columns[2].FieldIndex)
	}
	// Without the fixed category any category defines a known column.
	free := map[string]any{}
	for k, v := range mapping {
		free[k] = v
	}
	delete(free, "categoryId")
	free["fields"] = append([]any{map[string]any{"target": "product.category", "value": "Actuators"}}, mapping["fields"].([]any)...)
	if c := decode[imports.ImportColumns](t, api.Post("/api/import-columns", api.Admin.Cookie, map[string]any{"mapping": free})); c.Unknown != 0 ||
		c.Columns[3].Status != imports.ColumnCategory || c.Columns[3].Categories[0].Key != "other" {
		t.Errorf("free %v", statuses(c.Columns))
	}

	// Answers: an existing field (unknown key refused), and overriding an
	// automatic match.
	p := assertError(t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping, "answers": []any{
		map[string]any{"target": "attribute.extra", "fieldKey": "nope"},
		map[string]any{"target": "attribute.notes", "fieldKey": "remark", "information": true},
	}}), http.StatusUnprocessableEntity, "validation.failed")
	if got := fieldCodes(p); !reflect.DeepEqual(got, []string{"body.answers[0].fieldKey import.answer_field_not_found",
		"body.answers[1] import.answer_required"}) {
		t.Errorf("answers %v", got)
	}
	override := decode[imports.ImportColumns](t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping,
		"answers": []any{
			map[string]any{"target": "attribute.width", "information": true},
			map[string]any{"target": "attribute.bus", "fieldKey": "remark"},
		}}))
	if got := statuses(override.Columns)[:2]; !reflect.DeepEqual(got, []string{"attribute.width information", "attribute.bus field remark"}) {
		t.Errorf("override %v", got)
	}
	answered := decode[imports.ImportColumns](t, api.Post("/api/import-columns/answers", api.Admin.Cookie, map[string]any{"mapping": mapping,
		"answers": []any{
			map[string]any{"target": "attribute.extra", "fieldKey": "remark"},
			map[string]any{"target": "attribute.notes", "information": true},
		}}))
	if got := statuses(answered.Columns); !reflect.DeepEqual(got, []string{"attribute.width field module_width",
		"attribute.bus field bus_current", "attribute.extra field remark", "attribute.notes information"}) {
		t.Errorf("answered %v", got)
	}

	data := csvFile("Model;Name;Width (TE);Bus current;Extra;Notes;Price", "A-1;Actuator;4;12;x;;10")
	run := upload(t, api, "a.csv", data, "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": answered.Mapping})
	if run.Counts.Categories.Changed != 1 || run.Counts.Categories.New != 0 || run.Counts.Errors != 0 || run.Counts.Warnings != 1 {
		t.Fatalf("counts %+v %+v", run.Counts, issues(t, api, run.ID.String()))
	}
	if is := issues(t, api, run.ID.String()); is[0].Code != "import.attribute_not_linked" || is[0].Params["key"] != "bus" ||
		is[0].Params["field"] != "bus_current" || is[0].Params["category"] != "actuators" {
		t.Errorf("issues %+v", is)
	}
	var link *imports.ImportItem
	for _, it := range items(t, api, run.ID.String(), "") {
		if it.Entity == "category" {
			link = &it
		}
	}
	if link == nil || link.Status != "changed" || link.ID == nil || link.Key != "actuators" ||
		change(*link, "attributes.width.fieldKey") == nil || change(*link, "attributes.width.fieldKey").After != "module_width" ||
		change(*link, "attributes.extra.fieldKey") == nil || len(link.Changes) != 2 {
		t.Errorf("link item %+v", link)
	}
	applied := apply(t, api, run.ID.String(), nil)
	if applied.Counts.Categories.Changed != 1 {
		t.Errorf("applied %+v", applied.Counts)
	}
	links := map[string]any{}
	for _, a := range categoryList(t, api)["actuators"].Attributes {
		links[a["key"].(string)] = a["fieldKey"]
	}
	if !reflect.DeepEqual(links, map[string]any{"width": "module_width", "bus": nil, "extra": "remark"}) {
		t.Errorf("links %v", links)
	}
	// Undo leaves the links.
	undo(t, api, run.ID.String())
	if a := categoryList(t, api)["actuators"].Attributes[0]; a["fieldKey"] != "module_width" {
		t.Errorf("after undo %v", a)
	}

	// A linked field changed between preview and apply: stale.
	run = upload(t, api, "b.csv", data, "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": answered.Mapping})
	if run.Counts.Categories.Changed != 0 {
		t.Errorf("second preview %+v", run.Counts)
	}
	expect(t, api.Put("/api/catalog-fields/"+width.ID.String(), api.Admin.Cookie, map[string]any{"key": "module_width",
		"label": map[string]string{"en": "Module width"}, "type": "number", "unit": "TE", "meaning": "rail_width_te",
		"expectedUpdatedAt": width.UpdatedAt}), http.StatusOK)
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
}

// A profile that links a column to a field keeps the field's key: renaming
// it is catalog_field.key_referenced; other changes are fine.
func TestFieldKeyReferencedByProfile(t *testing.T) {
	api := apptest.New(t)
	f := decode[capabilities.CatalogField](t, api.Post("/api/catalog-fields", api.Admin.Cookie, map[string]any{"key": "remark",
		"label": map[string]string{"en": "Remark"}, "type": "text"}))
	mapping := map[string]any{"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "fields": []any{
		map[string]any{"target": "product.modelNumber", "column": "Model"},
		map[string]any{"target": "product.productType", "column": "System"},
		map[string]any{"target": "product.category", "column": "Category"},
		map[string]any{"target": "attribute.remark", "column": "Remark", "fieldKey": "remark"},
	}}
	expect(t, api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "P", "mapping": mapping}), http.StatusCreated)
	body := func(key string) map[string]any {
		return map[string]any{"key": key, "label": map[string]string{"en": "Remark"}, "type": "text", "expectedUpdatedAt": f.UpdatedAt}
	}
	assertError(t, api.Put("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie, body("note")), http.StatusConflict, "catalog_field.key_referenced")
	expect(t, api.Put("/api/catalog-fields/"+f.ID.String(), api.Admin.Cookie, body("remark")), http.StatusOK)
}
