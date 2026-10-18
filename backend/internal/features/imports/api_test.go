package imports_test

import (
	"net/http"
	"os"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc/importsrctest"
)

// The SnapFlow 1 workbook with the starter profile: every product on the
// Zigbee product type, categories created from Category, Dimensions as an
// attribute, Style as variant
// ("Standard" when empty), "Model Number + Style" as SKU, add-ons resolved
// by SKU, pictures per row with the product's first picture as fallback.
// Re-importing the same file changes nothing.
func TestStarterProfileImport(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	data := workbook(t, v1Rows(t))

	run := upload(t, api, "catalog.xlsx", data, profile)
	if run.State != imports.StatePreviewed || run.SourceKind != "xlsx" || run.FileName != "catalog.xlsx" ||
		run.ProfileName != imports.StarterProfileName || run.Mapping == nil || !run.AllOrNothing || !run.Can.Apply || run.Can.Undo ||
		run.UserName == "" || run.FileSize != int64(len(data)) {
		t.Fatalf("run %+v", run)
	}
	c := run.Counts
	want := imports.ImportCounts{
		Rows: 6, Categories: imports.ImportCounter{New: 4},
		Products: imports.ImportCounter{New: 4}, Variants: imports.ImportCounter{New: 6},
		Addons: imports.ImportAddonCounter{New: 3}, Images: imports.ImportImageCounter{New: 4, Files: 2},
		Unmapped: []imports.ImportSourceColumn{{Letter: "C", Header: "#"}, {Letter: "D", Header: "Item Photo"}},
	}
	if !reflect.DeepEqual(*c, want) {
		t.Fatalf("counts\n%+v\nwant\n%+v", *c, want)
	}
	if got := issues(t, api, run.ID.String()); len(got) != 0 {
		t.Errorf("issues %+v", got)
	}
	list := items(t, api, run.ID.String(), "")
	if len(list) != 4+4+6 || list[0].Entity != "category" || list[0].Key != "gateways" || list[0].Name["en"] != "Gateways" ||
		!reflect.DeepEqual(list[0].Rows, []int{4, 5}) {
		t.Fatalf("items %+v", list[:2])
	}
	zigbee := productTypes(t, api)["zigbee"]
	gw := item(t, list, "product", "GW-1", "")
	if gw.Status != "new" || !reflect.DeepEqual(gw.Rows, []int{4, 5}) || gw.Category.Key != "gateways" || gw.Category.ID != nil ||
		gw.ProductType.ID.String() != zigbee.ID || gw.ProductType.Abbreviation != "ZB" || change(gw, "productType") == nil ||
		change(gw, "category") == nil || change(gw, "attributes.dimensions").After != "45*47*19" ||
		change(gw, "description.en").After != "Gateway  for Zigbee" {
		t.Errorf("gateway item %+v", gw)
	}
	ash := item(t, list, "variant", "T-1", "Ash Grey")
	if ash.Status != "new" || ash.SKU != "T-1 Ash Grey" || change(ash, "price").After != "27.50" || change(ash, "addons") == nil {
		t.Errorf("ash item %+v", ash)
	}
	// Filters.
	if got := items(t, api, run.ID.String(), "entity=variant&status=new"); len(got) != 6 {
		t.Errorf("variant filter: %d", len(got))
	}
	page := decode[imports.ImportItemPage](t, api.Get("/api/imports/"+run.ID.String()+"/items?limit=5&offset=10", api.Admin.Cookie))
	if len(page.Items) != 4 || page.Total != 14 || page.Items[0].Seq <= list[9].Seq-1 {
		t.Errorf("paging: %d of %d", len(page.Items), page.Total)
	}

	applied := apply(t, api, run.ID.String(), nil)
	if applied.State != imports.StateApplied || applied.AppliedAt == nil || applied.Applied == nil || applied.Can.Apply || !applied.Can.Undo || applied.Can.Delete {
		t.Fatalf("applied %+v", applied)
	}
	if a := applied.Applied; a.Products.New != 4 || a.Variants.New != 6 || a.Categories.New != 4 || a.Addons.New != 3 || a.Images.New != 4 {
		t.Errorf("applied counts %+v", *a)
	}

	cats := categoryList(t, api)
	panels := cats["smart_panels"]
	if len(cats) != 4 || panels.Name["en"] != "Smart Panels" || len(panels.Attributes) != 1 || panels.Attributes[0]["key"] != "dimensions" ||
		panels.Attributes[0]["type"] != "text" || !reflect.DeepEqual(panels.Attributes[0]["label"], map[string]any{"en": "Dimensions (mm)"}) {
		t.Errorf("created category %+v", panels)
	}
	if len(productTypes(t, api)) != 1 {
		t.Error("the import created a product type")
	}
	cat := catalog(t, api)
	if len(cat) != 4 {
		t.Fatalf("catalog %d products", len(cat))
	}
	gateway := cat["GW-1"]
	if gateway.ProductType.Key != "zigbee" || gateway.Category.Key != "gateways" || gateway.Name["en"] != "Zigbee Gateway" ||
		!reflect.DeepEqual(gateway.Attributes, map[string]any{"dimensions": "45*47*19"}) ||
		gateway.Description["en"] != "Gateway  for Zigbee" {
		t.Errorf("gateway %+v", gateway)
	}
	white, black := variantByName(t, gateway, "White"), variantByName(t, gateway, "Black")
	if white.SKU != "GW-1 White" || white.Price != "108.00" || white.ImageFileID == "" || black.ImageFileID != white.ImageFileID {
		t.Errorf("gateway variants: the second must share the first row's picture: %+v / %+v", white, black)
	}
	tile := cat["T-1"]
	ivory, ashGrey := variantByName(t, tile, "Ivory White"), variantByName(t, tile, "Ash Grey")
	frame := variantByName(t, cat["F-1"], "Ivory White")
	if ivory.ImageFileID == "" || ivory.ImageFileID == white.ImageFileID || ashGrey.ImageFileID != ivory.ImageFileID {
		t.Errorf("tile pictures: %q %q", ivory.ImageFileID, ashGrey.ImageFileID)
	}
	if len(ivory.Addons) != 2 || ivory.Addons[0].AddonVariantID != frame.ID || !ivory.Addons[0].Required ||
		ivory.Addons[1].AddonVariantID != white.ID || ivory.Addons[1].Required {
		t.Errorf("ivory add-ons %+v", ivory.Addons)
	}
	if len(ashGrey.Addons) != 1 || ashGrey.Addons[0].AddonVariantID != frame.ID || ashGrey.Price != "27.50" {
		t.Errorf("ash grey %+v", ashGrey)
	}
	track := cat["TR-1"]
	if len(track.Variants) != 1 || track.Variants[0].Name["en"] != imports.StandardVariantName || track.Variants[0].SKU != "TR-1" ||
		track.Attributes["dimensions"] != "/" || frame.Price != "4.50" {
		t.Errorf("track %+v", track)
	}

	// The picture is served (the blue two-cell picture won over the green
	// one-cell picture of the same row).
	resp := api.Get("/api/files/"+ivory.ImageFileID, api.Admin.Cookie)
	expect(t, resp, http.StatusOK)

	// The change log lists every write.
	changes := decode[imports.ImportChangePage](t, api.Get("/api/imports/"+run.ID.String()+"/changes?limit=500", api.Admin.Cookie))
	kinds := map[string]int{}
	for _, c := range changes.Items {
		kinds[c.Entity+" "+c.Action]++
	}
	if !reflect.DeepEqual(kinds, map[string]int{"category create": 4, "product create": 4, "variant create": 6, "addons update": 2}) ||
		changes.Total != 16 {
		t.Errorf("change log %v (%d)", kinds, changes.Total)
	}

	// Re-importing the same file: everything unchanged.
	again := upload(t, api, "catalog.xlsx", data, profile)
	want = imports.ImportCounts{
		Rows: 6, Products: imports.ImportCounter{Unchanged: 4}, Variants: imports.ImportCounter{Unchanged: 6},
		Addons: imports.ImportAddonCounter{Unchanged: 3}, Images: imports.ImportImageCounter{Unchanged: 4, Files: 2},
		Unmapped: []imports.ImportSourceColumn{{Letter: "C", Header: "#"}, {Letter: "D", Header: "Item Photo"}},
	}
	if !reflect.DeepEqual(*again.Counts, want) {
		t.Errorf("re-import counts\n%+v\nwant\n%+v", *again.Counts, want)
	}
	for _, it := range items(t, api, again.ID.String(), "") {
		if it.Status != "unchanged" || len(it.Changes) != 0 {
			t.Errorf("re-import item %+v", it)
		}
	}
	applied = apply(t, api, again.ID.String(), nil)
	if changes := decode[imports.ImportChangePage](t, api.Get("/api/imports/"+again.ID.String()+"/changes", api.Admin.Cookie)); changes.Total != 0 {
		t.Errorf("unchanged import wrote %d changes", changes.Total)
	}
	if after := catalog(t, api); after["GW-1"].UpdatedAt != gateway.UpdatedAt {
		t.Error("unchanged product was written")
	}

	// Runs list, newest first.
	runs := decode[imports.ImportRunPage](t, api.Get("/api/imports?limit=10", api.Admin.Cookie))
	if runs.Total != 2 || runs.Items[0].ID != again.ID || runs.Items[1].State != imports.StateApplied {
		t.Errorf("runs %+v", runs)
	}
}

// Changed, unchanged and deactivated items. Only products of the file's
// pairs of product type and category are deactivated: other categories and
// other systems in the same category are never touched.
func TestDiff(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	rows := append(v1Rows(t), importsrctest.V1Row{Category: "Smart Panels", Name: "Tile 2 Buttons", Model: "T-2", Style: "Ivory White", Price: 30})
	apply(t, api, upload(t, api, "a.xlsx", workbook(t, rows), profile).ID.String(), nil)
	before := catalog(t, api)

	// Products created by hand: a Zigbee sensor in another category, and a
	// KNX panel in the file's Smart Panels category.
	zigbee := productTypes(t, api)["zigbee"]
	newProduct(t, api, zigbee.ID, newCategory(t, api, "sensors", "", nil).ID, "S-1")
	newProduct(t, api, newProductType(t, api, "knx", "KNX").ID, categoryList(t, api)["smart_panels"].ID, "K-1")

	rows = v1Rows(t)
	rows[0].Price = 99.5                      // GW-1 White: price changes
	rows[0].Name = "Zigbee Gateway Pro"       // product name changes
	rows = slices.Delete(rows, 4, 5)          // T-1 Ash Grey: deactivated
	rows = rows[:len(rows)-2]                 // F-1 and TR-1: their categories are not in the file, so they stay
	rows[3].Required = []string{"GW-1 Black"} // T-1 Ivory: add-ons change
	run := upload(t, api, "b.xlsx", workbook(t, rows), profile)
	list := items(t, api, run.ID.String(), "")

	gw := item(t, list, "product", "GW-1", "")
	if gw.Status != "changed" || gw.ID == nil || len(gw.Changes) != 1 || gw.Changes[0].Field != "name.en" ||
		gw.Changes[0].Before != "Zigbee Gateway" || gw.Changes[0].After != "Zigbee Gateway Pro" {
		t.Errorf("gateway %+v", gw)
	}
	white := item(t, list, "variant", "GW-1", "White")
	if white.Status != "changed" || len(white.Changes) != 1 || white.Changes[0].Before != "108.00" || white.Changes[0].After != "99.50" {
		t.Errorf("white %+v", white)
	}
	if black := item(t, list, "variant", "GW-1", "Black"); black.Status != "unchanged" {
		t.Errorf("black %+v", black)
	}
	ash := item(t, list, "variant", "T-1", "Ash Grey")
	if ash.Status != "deactivate" || change(ash, "isActive").After != false {
		t.Errorf("ash %+v", ash)
	}
	if t2 := item(t, list, "product", "T-2", ""); t2.Status != "deactivate" || len(t2.Rows) != 0 {
		t.Errorf("T-2 must be deactivated (Zigbee and its category are in the file): %+v", t2)
	}
	ivory := item(t, list, "variant", "T-1", "Ivory White")
	addons := change(ivory, "addons")
	if ivory.Status != "changed" || addons == nil {
		t.Fatalf("ivory %+v", ivory)
	}
	for _, it := range list {
		if it.ModelNumber == "F-1" || it.ModelNumber == "TR-1" || it.ModelNumber == "S-1" || it.ModelNumber == "K-1" {
			t.Errorf("untouched product in the diff: %+v", it)
		}
	}
	c := run.Counts
	if c.Products != (imports.ImportCounter{Changed: 1, Unchanged: 1, Deactivate: 1}) ||
		c.Variants != (imports.ImportCounter{Changed: 2, Unchanged: 1, Deactivate: 1}) ||
		c.Addons != (imports.ImportAddonCounter{New: 1, Unchanged: 1, Removed: 1}) {
		t.Errorf("counts %+v", *c)
	}

	apply(t, api, run.ID.String(), nil)
	after := catalog(t, api)
	if after["GW-1"].Name["en"] != "Zigbee Gateway Pro" || variantByName(t, after["GW-1"], "White").Price != "99.50" ||
		variantByName(t, after["T-1"], "Ash Grey").IsActive || after["T-2"].IsActive || !after["F-1"].IsActive ||
		!after["TR-1"].IsActive || !after["S-1"].IsActive || !after["K-1"].IsActive {
		t.Errorf("after apply: %+v", after)
	}
	if v := variantByName(t, after["T-1"], "Ivory White"); len(v.Addons) != 2 || v.Addons[0].AddonVariantID != variantByName(t, after["GW-1"], "Black").ID {
		t.Errorf("ivory add-ons %+v", v.Addons)
	}
	if after["F-1"].UpdatedAt != before["F-1"].UpdatedAt {
		t.Error("F-1 was written")
	}

	// The full file again: deactivated items come back, as changes.
	run = upload(t, api, "c.xlsx", workbook(t, v1Rows(t)), profile)
	list = items(t, api, run.ID.String(), "")
	if ash := item(t, list, "variant", "T-1", "Ash Grey"); ash.Status != "changed" || change(ash, "isActive").After != true {
		t.Errorf("reactivated %+v", ash)
	}
}

// Add-on references resolve against the file first, then the catalog, by
// SKU ignoring case and repeated white space; unresolved ones are warnings.
func TestAddonResolution(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	extID := newProduct(t, api, productTypes(t, api)["zigbee"].ID, newCategory(t, api, "extras", "", nil).ID, "EXT-1").ID
	resp := api.Post("/api/products/"+extID+"/variants", api.Admin.Cookie, map[string]any{"name": map[string]string{"en": "Blue"}, "sku": "EXT-1 Blue", "price": "1.00", "isActive": true})
	expect(t, resp, http.StatusCreated)
	extVariant := decode[variant](t, resp)

	rows := []importsrctest.V1Row{
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "White", Price: 1,
			Required: []string{"ext-1   BLUE", "NOPE 1", "T-1 White"}, Optional: []string{"t-2  black", "EXT-1 Blue"}},
		{Category: "Panels", Name: "Tile 2", Model: "T-2", Style: "Black", Price: 2},
	}
	run := upload(t, api, "a.xlsx", workbook(t, rows), profile)
	got := issues(t, api, run.ID.String())
	codes := []string{}
	for _, is := range got {
		codes = append(codes, is.Code+" "+is.Column+" "+is.Severity)
	}
	sort.Strings(codes)
	if !reflect.DeepEqual(codes, []string{"addon.duplicate R warning", "addon.self O warning", "import.addon_not_found N warning"}) {
		t.Errorf("issues %v", codes)
	}
	for _, is := range got {
		if is.Code == "import.addon_not_found" && (is.Params["ref"] != "NOPE 1" || is.Row != 4 || is.Header != "Mandatory Addon - 02" || is.Target != "addon.required") {
			t.Errorf("not found %+v", is)
		}
	}
	if run.Counts.Addons != (imports.ImportAddonCounter{New: 2, Unresolved: 1}) || run.Counts.Warnings != 3 || run.Counts.Errors != 0 {
		t.Errorf("counts %+v", run.Counts)
	}
	apply(t, api, run.ID.String(), nil)
	cat := catalog(t, api)
	tile := variantByName(t, cat["T-1"], "White")
	if len(tile.Addons) != 2 || tile.Addons[0].AddonVariantID != extVariant.ID || !tile.Addons[0].Required ||
		tile.Addons[1].AddonVariantID != variantByName(t, cat["T-2"], "Black").ID || tile.Addons[1].Required {
		t.Errorf("add-ons %+v", tile.Addons)
	}
}

// Rows with errors: all or nothing refuses the apply; without it they are
// skipped and the rest is applied.
func TestRowErrors(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	rows := []importsrctest.V1Row{
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "White", Price: "abc"},               // price error: variant skipped
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "Black", Price: 2},                   // fine
		{Category: "Panels", Name: "Tile", Model: "T-1", Style: "black", Price: 3},                   // duplicate variant
		{Category: "Panels", Name: "", Model: "T-2", Style: "White", Price: 2},                       // no product name: product skipped
		{Category: "Panels", Name: "Other", Model: "", Style: "White", Price: 2},                     // no model number
		{Category: "Panels", Name: "Tile 3", Model: "T-3", Style: "Red", Price: "-1"},                // negative price
		{Category: "Panels", Name: "Tile 4", Model: "T-4", Style: "Red", Price: 1, SKU: "T-1 Black"}, // SKU used twice
		{Category: "Panels", Name: "Tile Other", Model: "t-1", Style: "Green", Price: 1},             // same product (case), name conflict
	}
	run := upload(t, api, "a.xlsx", workbook(t, rows), profile)
	got := []string{}
	for _, is := range issues(t, api, run.ID.String()) {
		got = append(got, strings.Join([]string{strconv.Itoa(is.Row), is.Column, is.Severity, is.Code}, " "))
	}
	want := []string{
		"4 K error variant.price_format",
		"6 I error import.duplicate_variant",
		"6 J error import.duplicate_sku",
		"7 E error validation.required",
		"8 G error validation.required",
		"9 K error variant.price_format",
		"10 J error import.duplicate_sku",
		"11 E warning import.product_field_conflict",
	}
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("issues\n%v\nwant\n%v", got, want)
	}
	if run.Counts.Errors != 7 || run.Counts.Warnings != 1 || run.Counts.RowsSkipped != 6 {
		t.Errorf("counts %+v", run.Counts)
	}
	// T-1 White and black, T-2 with its variant, T-3 and T-4 with their
	// only variant (every row of theirs has errors: the product is not
	// created either).
	if skipped := items(t, api, run.ID.String(), "skipped=true"); len(skipped) != 8 {
		t.Errorf("skipped items %d", len(skipped))
	}
	p := assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusUnprocessableEntity, "import.has_errors")
	if p.Params["count"] != 7.0 {
		t.Errorf("params %v", p.Params)
	}
	if len(catalog(t, api)) != 0 {
		t.Fatal("refused apply wrote")
	}
	applied := apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	if applied.State != imports.StateApplied || applied.AllOrNothing {
		t.Fatalf("applied %+v", applied)
	}
	cat := catalog(t, api)
	// T-1 with Black and Green; T-2 (no name), T-3 (bad price) and T-4
	// (SKU used twice) skipped.
	if len(cat) != 1 || len(cat["T-1"].Variants) != 2 {
		t.Errorf("catalog %+v", cat)
	}
}

// A write that fails during apply rolls everything back with all or
// nothing (the run fails); without it the product is skipped.
func TestApplyFailure(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), profile)
	defer imports.SetFailHook(func(it imports.ImportItem) error {
		if it.ModelNumber == "T-1" && it.Entity == "variant" {
			// Not an error that means the catalog changed (those are
			// import.stale): a write the services refuse.
			return apperr.New(http.StatusUnprocessableEntity, "variant.price_format", "injected").With("sku", it.SKU)
		}
		return nil
	})()

	failed := apply(t, api, run.ID.String(), nil)
	if failed.State != imports.StateFailed || failed.Error == nil || failed.Error.Code != "variant.price_format" ||
		failed.Error.Params["sku"] != "T-1 Ivory White" || !reflect.DeepEqual(failed.Error.Rows, []int{7}) || !failed.Can.Preview || failed.Can.Apply {
		t.Fatalf("failed run %+v %+v", failed, failed.Error)
	}
	if len(catalog(t, api)) != 0 || len(categoryList(t, api)) != 0 {
		t.Fatal("a failed apply left changes")
	}
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.state")

	// Preview again and skip: T-1 (its product and variants) is left out.
	preview(t, api, run.ID.String(), map[string]any{"profileId": profile})
	applied := apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	if applied.State != imports.StateApplied {
		t.Fatalf("applied %+v", applied)
	}
	cat := catalog(t, api)
	if _, ok := cat["T-1"]; ok || len(cat) != 3 {
		t.Errorf("catalog %v", len(cat))
	}
	found := false
	for _, is := range issues(t, api, run.ID.String()) {
		found = found || (is.Code == "variant.price_format" && is.Row == 7 && is.ModelNumber == "T-1" && is.ItemSeq != 0)
	}
	if !found {
		t.Error("the skipped product has no issue")
	}
	if applied.Applied.Products.New != 3 || applied.Applied.Errors != 1 {
		t.Errorf("applied %+v", applied.Applied)
	}
}

// A preview whose catalog changed since is stale.
func TestStalePreview(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), profile)
	// A category the file names, created since (the run would create it).
	newCategory(t, api, "frames", "", nil)
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
	// A product type the profile's value matches (by its abbreviation) is
	// part of what a preview reads; others are not.
	preview(t, api, run.ID.String(), map[string]any{"profileId": profile})
	newProductType(t, api, "knx", "KNX")
	newProductType(t, api, "zigbee_3", "ZIGBEE")
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
	if r := decode[imports.ImportRun](t, api.Get("/api/imports/"+run.ID.String(), api.Admin.Cookie)); r.State != imports.StatePreviewed {
		t.Errorf("state %s", r.State)
	}
	preview(t, api, run.ID.String(), map[string]any{"profileId": profile})
	apply(t, api, run.ID.String(), nil)

	// An edited variant makes a second preview stale.
	run = upload(t, api, "b.xlsx", workbook(t, v1Rows(t)), profile)
	p := catalog(t, api)["F-1"]
	v := p.Variants[0]
	resp := api.Put("/api/products/"+p.ID+"/variants/"+v.ID, api.Admin.Cookie, map[string]any{
		"name": v.Name, "sku": v.SKU, "price": "5.00", "isActive": true, "expectedUpdatedAt": v.UpdatedAt,
	})
	expect(t, resp, http.StatusOK)
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.stale")
}

// Undo reverts an applied run unless something it touched changed since.
func TestUndo(t *testing.T) {
	api := apptest.New(t)
	profile := starterID(t, api)
	first := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), profile)
	apply(t, api, first.ID.String(), nil)
	before := catalog(t, api)

	// A second run changes a price, deactivates a variant and changes
	// add-ons; undoing it restores the first state exactly.
	rows := v1Rows(t)
	rows[0].Price = 1
	rows = slices.Delete(rows, 4, 5)
	rows[3].Optional = nil
	second := upload(t, api, "b.xlsx", workbook(t, rows), profile)
	apply(t, api, second.ID.String(), nil)
	if catalog(t, api)["GW-1"].Variants[0].Price != "1.00" {
		t.Fatal("second run not applied")
	}
	undone := undo(t, api, second.ID.String())
	if undone.State != imports.StateUndone || undone.UndoneAt == nil || undone.Can.Undo || undone.Can.Apply || !undone.Can.Delete {
		t.Fatalf("undone %+v", undone)
	}
	after := catalog(t, api)
	for model, p := range before {
		q := after[model]
		for i := range p.Variants {
			pv, qv := p.Variants[i], q.Variants[i]
			pv.UpdatedAt, qv.UpdatedAt = "", ""
			if !reflect.DeepEqual(pv, qv) {
				t.Errorf("%s variant %d: %+v, want %+v", model, i, qv, pv)
			}
		}
		p.UpdatedAt, q.UpdatedAt, p.Variants, q.Variants = "", "", nil, nil
		if !reflect.DeepEqual(p, q) {
			t.Errorf("%s: %+v, want %+v", model, q, p)
		}
	}
	assertError(t, api.Post("/api/imports/"+second.ID.String()+"/undo", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.state")

	// Undo conflict: a product the first run created was edited since.
	gw := after["GW-1"]
	resp := api.Put("/api/products/"+gw.ID, api.Admin.Cookie, map[string]any{
		"productTypeId": gw.ProductTypeID, "categoryId": gw.CategoryID, "modelNumber": "GW-1", "name": map[string]string{"en": "Edited"},
		"attributes": gw.Attributes, "isActive": true, "expectedUpdatedAt": gw.UpdatedAt,
	})
	expect(t, resp, http.StatusOK)
	// A link from a hand-made variant to a variant the run created.
	x := newProduct(t, api, gw.ProductTypeID, newCategory(t, api, "other", "", nil).ID, "X-1")
	resp = api.Post("/api/products/"+x.ID+"/variants", api.Admin.Cookie, map[string]any{"name": map[string]string{"en": "X"}, "price": "1", "isActive": true})
	expect(t, resp, http.StatusCreated)
	xv := decode[variant](t, resp)
	expect(t, api.Put("/api/products/"+x.ID+"/variants/"+xv.ID+"/addons", api.Admin.Cookie, map[string]any{
		"addons": []any{map[string]any{"addonVariantId": variantByName(t, after["F-1"], "Ivory White").ID}},
	}), http.StatusOK)

	p := assertError(t, api.Post("/api/imports/"+first.ID.String()+"/undo", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.undo_conflict")
	labels := []string{}
	for _, e := range p.Params["entities"].([]any) {
		m := e.(map[string]any)
		labels = append(labels, m["entity"].(string)+" "+m["label"].(string))
		// Variants and add-on lists name their product, for a link.
		if m["entity"] == "addons" && m["productId"] != x.ID {
			t.Errorf("conflict %v: productId, want %s", m, x.ID)
		}
		if m["entity"] == "product" && m["productId"] != nil {
			t.Errorf("conflict %v: a product has no productId", m)
		}
	}
	sort.Strings(labels)
	if !reflect.DeepEqual(labels, []string{"addons X-1 X", "product GW-1"}) || p.Params["count"] != 2.0 {
		t.Errorf("conflicts %v %v", labels, p.Params)
	}

	// Without the conflicts, undo deletes everything the run created.
	expect(t, api.Delete("/api/products/"+x.ID, api.Admin.Cookie), http.StatusNoContent)
	gw = catalog(t, api)["GW-1"]
	resp = api.Put("/api/products/"+gw.ID, api.Admin.Cookie, map[string]any{
		"productTypeId": gw.ProductTypeID, "categoryId": gw.CategoryID, "modelNumber": "GW-1", "name": map[string]string{"en": "Again"},
		"attributes": gw.Attributes, "isActive": true, "expectedUpdatedAt": gw.UpdatedAt,
	})
	expect(t, resp, http.StatusOK)
	assertError(t, api.Post("/api/imports/"+first.ID.String()+"/undo", api.Admin.Cookie, map[string]any{}), http.StatusConflict, "import.undo_conflict")
}

// Undoing a run that created everything leaves the catalog empty.
func TestUndoCreated(t *testing.T) {
	api := apptest.New(t)
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), starterID(t, api))
	apply(t, api, run.ID.String(), nil)
	undo(t, api, run.ID.String())
	if len(catalog(t, api)) != 0 || len(categoryList(t, api)) != 0 || len(productTypes(t, api)) != 1 {
		t.Error("undo left created items (or removed the product type, which the run did not create)")
	}
}

func TestPermissions(t *testing.T) {
	api := apptest.New(t)
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), "")
	tenant := api.NewTenant("Partner")
	for _, s := range []apptest.Session{api.NewUser(tenant, auth.RoleUser), api.NewUser(tenant, auth.RoleTenantAdmin)} {
		for _, resp := range []interface{ Result() *http.Response }{
			api.Get("/api/imports", s.Cookie),
			api.Get("/api/imports/"+run.ID.String(), s.Cookie),
			api.Get("/api/import-profiles", s.Cookie),
			api.Get("/api/import-targets", s.Cookie),
			api.Post("/api/import-profiles", s.Cookie, map[string]any{"name": "x", "mapping": imports.StarterMapping()}),
			api.Post("/api/imports/"+run.ID.String()+"/preview", s.Cookie, map[string]any{"mapping": imports.StarterMapping()}),
			api.Post("/api/imports/"+run.ID.String()+"/apply", s.Cookie, map[string]any{}),
			api.Post("/api/imports/"+run.ID.String()+"/undo", s.Cookie, map[string]any{}),
			uploadRaw(api, s.Cookie, "a.xlsx", workbook(t, v1Rows(t))),
		} {
			if code := resp.Result().StatusCode; code != http.StatusForbidden {
				t.Errorf("%s %s: got %d", s.Email, resp.Result().Request.URL, code)
			}
		}
	}
	for _, resp := range []interface{ Result() *http.Response }{
		api.Get("/api/imports"),
		api.Get("/api/import-profiles"),
		uploadRaw(api, "", "a.xlsx", workbook(t, v1Rows(t))),
	} {
		if code := resp.Result().StatusCode; code != http.StatusUnauthorized {
			t.Errorf("anonymous: got %d", code)
		}
	}
}

func TestLimitsAndFileTypes(t *testing.T) {
	api := apptest.New(t)
	assertError(t, uploadRaw(api, api.Admin.Cookie, "a.xls", []byte("\xd0\xcf\x11\xe0 legacy")), http.StatusUnsupportedMediaType, "import.file_type")
	assertError(t, uploadRaw(api, api.Admin.Cookie, "a.txt", []byte("a;b\n")), http.StatusUnsupportedMediaType, "import.file_type")
	assertError(t, uploadRaw(api, api.Admin.Cookie, "a.xlsx", []byte("a;b\n")), http.StatusUnsupportedMediaType, "import.file_type")
	assertError(t, uploadRaw(api, api.Admin.Cookie, "a.xlsx", append([]byte("PK\x03\x04"), make([]byte, 64)...)), http.StatusUnprocessableEntity, "import.unreadable")

	big := make([]byte, imports.MaxFileSize+1)
	p := assertError(t, uploadRaw(api, api.Admin.Cookie, "a.csv", big), http.StatusRequestEntityTooLarge, "import.too_large")
	if p.Params["maxMb"] != 50.0 {
		t.Errorf("params %v", p.Params)
	}

	// The row limit counts data rows (from the first data row): a title,
	// a blank line and the header row above 20 000 data rows are fine.
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	lines := []string{"Price list", "", "Model;Name;Price"}
	for i := range imports.MaxRows {
		lines = append(lines, "M-"+strconv.Itoa(i)+";N;1")
	}
	run := upload(t, api, "a.csv", csvFile(lines...), "")
	if run.State != imports.StateUploaded || run.SourceKind != "csv" {
		t.Errorf("run %+v", run)
	}
	mapping := map[string]any{"sourceKind": "csv", "headerRow": 3, "dataStartRow": 4, "productTypeId": pt.ID, "categoryId": cat.ID,
		"fields": []any{map[string]any{"target": "product.modelNumber", "column": "Model"}, map[string]any{"target": "product.name.en", "column": "Name"},
			map[string]any{"target": "variant.price", "column": "Price"}}}
	if run = preview(t, api, run.ID.String(), map[string]any{"mapping": mapping}); run.Counts.Rows != imports.MaxRows {
		t.Errorf("rows %d", run.Counts.Rows)
	}
	// One data row more: refused by the preview.
	run = upload(t, api, "b.csv", csvFile(append(lines, "M-x;N;1")...), "")
	p = assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"mapping": mapping}),
		http.StatusUnprocessableEntity, "import.too_many_rows")
	if p.Params["max"] != float64(imports.MaxRows) {
		t.Errorf("params %v", p.Params)
	}
	// Far more rows than any mapping allows: refused at upload.
	for i := range imports.MaxLeadingRows {
		lines = append(lines, "X-"+strconv.Itoa(i)+";N;1")
	}
	assertError(t, uploadRaw(api, api.Admin.Cookie, "c.csv", csvFile(lines...)), http.StatusUnprocessableEntity, "import.too_many_rows")
	wide := "Model" + strings.Repeat(";", imports.MaxColumns) + "x"
	assertError(t, uploadRaw(api, api.Admin.Cookie, "d.csv", csvFile(wide)), http.StatusUnprocessableEntity, "import.too_many_columns")

	// A file without data rows.
	run = upload(t, api, "b.csv", csvFile("Model;Price"), "")
	m := imports.ImportMapping{SourceKind: "csv", HeaderRow: 1, DataStartRow: 2, ProductTypeID: nil, Fields: []imports.ImportField{
		{Target: "product.modelNumber", Column: "Model"}, {Target: "product.productType", Value: str("x")},
		{Target: "product.category", Value: str("y")},
	}}
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"mapping": m}), http.StatusUnprocessableEntity, "import.no_rows")
}

// A CSV with a fixed product type and category, constants and lenient
// cell values; and a column the file lacks.
func TestCSVFixedTypeAndConstants(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", []any{
		map[string]any{"key": "bus_system", "label": map[string]string{"en": "Bus"}, "type": "enum", "options": []any{
			map[string]any{"key": "zigbee", "label": map[string]string{"en": "Zigbee"}},
			map[string]any{"key": "knx", "label": map[string]string{"en": "KNX", "de": "KNX-Bus"}},
		}},
		map[string]any{"key": "width", "label": map[string]string{"en": "Width"}, "type": "number"},
		map[string]any{"key": "dimmable", "label": map[string]string{"en": "Dimmable"}, "type": "boolean", "scope": "variant"},
		map[string]any{"key": "loads", "label": map[string]string{"en": "Loads"}, "type": "list", "itemType": "text"},
	})
	data := csvFile(
		"\xef\xbb\xbfArtikel;Bezeichnung;Variante;Preis;Breite;Dimmbar;Lasten",
		"D-1;Dimmer;Weiß;\"1.234,50\";2,5;ja;LED, Halogen",
		"D-1;Dimmer;Schwarz;12;2,5;nein;LED, Halogen",
	)
	run := upload(t, api, "dimmer.csv", data, "")
	src := decode[imports.ImportSourcePreview](t, api.Get("/api/imports/"+run.ID.String()+"/source?headerRow=1", api.Admin.Cookie))
	if len(src.Columns) != 7 || src.Columns[0] != (imports.ImportSourceColumn{Letter: "A", Header: "Artikel"}) || src.DataRows != 2 ||
		len(src.Rows) != 2 || src.Rows[0].Number != 2 || src.Rows[0].Cells[3] != "1.234,50" || !reflect.DeepEqual(src.Sheets, []string{""}) {
		t.Errorf("source %+v", src)
	}
	// allOrNothing and createMissingCategories may be left out (on and off).
	m := map[string]any{
		"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "productTypeId": pt.ID, "categoryId": cat.ID,
		"fields": []any{
			map[string]any{"target": "product.modelNumber", "column": "artikel"},
			map[string]any{"target": "product.name.de", "column": "Bezeichnung"},
			map[string]any{"target": "product.name.en", "value": "Dimmer actuator"},
			map[string]any{"target": "variant.name.en", "column": "Variante"},
			map[string]any{"target": "variant.price", "column": "Preis"},
			map[string]any{"target": "attribute.bus_system", "value": "KNX-Bus"},
			map[string]any{"target": "attribute.width", "columnLetter": "E"},
			map[string]any{"target": "attribute.dimmable", "column": "Dimmbar"},
			map[string]any{"target": "attribute.loads", "column": "Lasten"},
		},
	}
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Errors != 0 || run.Counts.Products.New != 1 || run.Counts.Variants.New != 2 || run.ProfileID != nil ||
		!run.AllOrNothing || !run.Mapping.AllOrNothing || run.Mapping.CreateMissingCategories {
		t.Fatalf("counts %+v %+v", run.Counts, issues(t, api, run.ID.String()))
	}
	apply(t, api, run.ID.String(), nil)
	d := catalog(t, api)["D-1"]
	if d.ProductTypeID != pt.ID || d.CategoryID != cat.ID || !reflect.DeepEqual(d.Name, map[string]string{"en": "Dimmer actuator", "de": "Dimmer"}) ||
		!reflect.DeepEqual(d.Attributes, map[string]any{"bus_system": "knx", "width": 2.5, "loads": []any{"LED", "Halogen"}}) {
		t.Errorf("product %+v", d)
	}
	white := variantByName(t, d, "Weiß")
	if white.Price != "1234.50" || white.Attributes["dimmable"] != true || variantByName(t, d, "Schwarz").Attributes["dimmable"] != false {
		t.Errorf("variant %+v", white)
	}

	// A mapped column the file lacks.
	m["fields"] = append(m["fields"].([]any), map[string]any{"target": "variant.sku", "column": "Artikelnummer"})
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"mapping": m}), http.StatusConflict, "import.state")
	run = upload(t, api, "dimmer.csv", data, "")
	p := assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"mapping": m}), http.StatusUnprocessableEntity, "validation.failed")
	if !reflect.DeepEqual(fieldCodes(p), []string{"body.mapping.fields[9].column import.column_missing"}) || p.Fields[0].Params["column"] != "Artikelnummer" {
		t.Errorf("fields %v", p.Fields)
	}
	// An unknown attribute (not in the category's schema).
	m["fields"] = append(m["fields"].([]any)[:9], map[string]any{"target": "attribute.colour", "value": "red"})
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	got := issues(t, api, run.ID.String())
	if len(got) != 1 || got[0].Code != "attribute.unknown" || got[0].Target != "attribute.colour" || got[0].Row != 2 {
		t.Errorf("issues %+v", got)
	}
}

// Product types match by key, English name or abbreviation and are never
// created; categories match by key or English name (ignoring case), and
// unknown ones are row errors or, with createMissingCategories, created.
func TestCategoryAndTypeResolution(t *testing.T) {
	api := apptest.New(t)
	resp := api.Post("/api/product-types", api.Admin.Cookie, map[string]any{
		"key": "zigbee", "name": map[string]string{"en": "Zigbee Home"}, "abbreviation": "ZB", "isActive": true,
	})
	expect(t, resp, http.StatusCreated)
	zigbee := decode[productType](t, resp)
	knx := newProductType(t, api, "knx", "")
	gateways := newCategory(t, api, "gw_cat", "Gateways", nil)
	frames := newCategory(t, api, "frames", "Tile frames", nil)
	data := csvFile(
		"Model;System;Category;Name;Price",
		"A-1;ZB;Gateways;A;1",           // type by abbreviation, category by English name
		"A-2;KNX;frames;B;1",            // type by key (case), category by key
		"A-3;zigbee  home;GATEWAYS;C;1", // type by English name (case, white space), category by name (case)
		"A-4;Bluetooth;Gateways;D;1",
		"A-5;ZB;Shading;E;1",
	)
	m := imports.ImportMapping{SourceKind: "csv", HeaderRow: 1, DataStartRow: 2, Fields: []imports.ImportField{
		{Target: "product.modelNumber", Column: "Model"},
		{Target: "product.productType", Column: "System"},
		{Target: "product.category", Column: "Category"},
		{Target: "product.name.en", Column: "Name"},
		{Target: "variant.price", Column: "Price"},
	}}
	run := upload(t, api, "a.csv", data, "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	got := []string{}
	for _, is := range issues(t, api, run.ID.String()) {
		got = append(got, strings.Join([]string{strconv.Itoa(is.Row), is.Column, is.Target, is.Code, is.Params["value"].(string)}, " "))
	}
	if !reflect.DeepEqual(got, []string{
		"5 B product.productType import.product_type_unknown Bluetooth",
		"6 C product.category import.category_unknown Shading",
	}) {
		t.Errorf("issues %v", got)
	}
	if run.Counts.Categories.New != 0 || run.Counts.Products.New != 5 || run.Counts.RowsSkipped != 2 {
		t.Errorf("counts %+v", run.Counts)
	}
	list := items(t, api, run.ID.String(), "")
	for model, want := range map[string][2]string{"A-1": {zigbee.ID, gateways.ID}, "A-2": {knx.ID, frames.ID}, "A-3": {zigbee.ID, gateways.ID}} {
		it := item(t, list, "product", model, "")
		if it.Skipped || it.ProductType.ID.String() != want[0] || it.Category.ID == nil || it.Category.ID.String() != want[1] {
			t.Errorf("%s: %+v %+v", model, it.ProductType, it.Category)
		}
	}
	if a1 := item(t, list, "product", "A-1", ""); a1.ProductType.Abbreviation != "ZB" || a1.ProductType.Name["en"] != "Zigbee Home" {
		t.Errorf("type ref %+v", a1.ProductType)
	}

	// With createMissingCategories the unknown category is created; the
	// unknown product type stays an error.
	m.CreateMissingCategories = true
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Categories.New != 1 || run.Counts.Errors != 1 {
		t.Errorf("counts %+v", run.Counts)
	}
	shading := item(t, items(t, api, run.ID.String(), "entity=category"), "category", "", "Shading")
	if shading.Key != "shading" || shading.Status != "new" || !reflect.DeepEqual(shading.Rows, []int{6}) || shading.Skipped {
		t.Errorf("new category %+v", shading)
	}
	apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	cat := catalog(t, api)
	if len(cat) != 4 || cat["A-5"].Category.Key != "shading" || cat["A-5"].ProductType.Key != "zigbee" || cat["A-2"].ProductType.Key != "knx" {
		t.Errorf("catalog %+v", cat)
	}
	if types := productTypes(t, api); len(types) != 2 {
		t.Errorf("the import created a product type: %v", types)
	}
}

// A category that only skipped products (errors in their own row) use is
// not created.
func TestNewCategoryOfSkippedRows(t *testing.T) {
	api := apptest.New(t)
	newProductType(t, api, "zigbee", "ZB")
	m := imports.ImportMapping{SourceKind: "csv", HeaderRow: 1, DataStartRow: 2, CreateMissingCategories: true, Fields: []imports.ImportField{
		{Target: "product.modelNumber", Column: "Model"},
		{Target: "product.productType", Value: str("ZB")},
		{Target: "product.category", Column: "Category"},
		{Target: "product.name.en", Column: "Name"},
		{Target: "variant.price", Column: "Price"},
	}}
	run := upload(t, api, "a.csv", csvFile("Model;Category;Name;Price", "A-1;Good;A;1", "A-2;Bad;;1"), "")
	run = preview(t, api, run.ID.String(), map[string]any{"mapping": m})
	if run.Counts.Categories.New != 2 || run.Counts.Errors != 1 {
		t.Fatalf("counts %+v", run.Counts)
	}
	applied := apply(t, api, run.ID.String(), map[string]any{"allOrNothing": false})
	cats := categoryList(t, api)
	if _, ok := cats["bad"]; ok || len(cats) != 1 || applied.Applied.Categories.New != 1 {
		t.Errorf("categories %v, applied %+v", cats, applied.Applied)
	}
}

// A fixed product type with a category column: the scope of deactivation
// is the pairs of type and category, so another system's products in the
// same category stay. The same file again changes nothing.
func TestFixedTypeWithCategoryColumn(t *testing.T) {
	api := apptest.New(t)
	knx := newProductType(t, api, "knx", "KNX")
	zigbee := newProductType(t, api, "zigbee", "ZB")
	dimmers := newCategory(t, api, "dimmers", "Dimmer actuators", []any{
		map[string]any{"key": "channels", "label": map[string]string{"en": "Channels"}, "type": "integer"},
	})
	oldKNX := newProduct(t, api, knx.ID, dimmers.ID, "K-OLD")
	otherSystem := newProduct(t, api, zigbee.ID, dimmers.ID, "Z-1")
	data := csvFile(
		"Model;Category;Name;Channels;Price",
		"K-1;Dimmer actuators;Dimmer 4ch;4;100",
		"K-2;dimmers;Dimmer 8ch;8;180",
		"K-3;Switch actuators;Switch 8ch;;120",
	)
	m := imports.ImportMapping{SourceKind: "csv", HeaderRow: 1, DataStartRow: 2, ProductTypeID: ptr(knx.ID), CreateMissingCategories: true,
		Fields: []imports.ImportField{
			{Target: "product.modelNumber", Column: "Model"},
			{Target: "product.category", Column: "Category"},
			{Target: "product.name.en", Column: "Name"},
			{Target: "attribute.channels", Column: "Channels"},
			{Target: "variant.price", Column: "Price"},
		}}
	resp := api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "KNX supplier", "mapping": m})
	expect(t, resp, http.StatusCreated)
	profile := decode[imports.ImportProfile](t, resp).ID.String()

	run := upload(t, api, "knx.csv", data, profile)
	if run.Counts.Errors != 0 || run.Counts.Categories.New != 1 || run.Counts.Products != (imports.ImportCounter{New: 3, Deactivate: 1}) {
		t.Fatalf("counts %+v %+v", run.Counts, issues(t, api, run.ID.String()))
	}
	list := items(t, api, run.ID.String(), "")
	if old := item(t, list, "product", "K-OLD", ""); old.Status != "deactivate" || old.ProductType.Key != "knx" || old.Category.Key != "dimmers" {
		t.Errorf("K-OLD %+v", old)
	}
	apply(t, api, run.ID.String(), nil)
	cat := catalog(t, api)
	if cat["K-OLD"].IsActive || !cat["Z-1"].IsActive || cat["Z-1"].UpdatedAt != otherSystem.UpdatedAt || oldKNX.ID != cat["K-OLD"].ID {
		t.Errorf("scope: K-OLD %+v, Z-1 %+v", cat["K-OLD"], cat["Z-1"])
	}
	if cat["K-1"].Category.Key != "dimmers" || cat["K-1"].ProductType.Key != "knx" || cat["K-2"].Attributes["channels"] != 8.0 ||
		cat["K-3"].Category.Key != "switch_actuators" {
		t.Errorf("imported %+v / %+v / %+v", cat["K-1"], cat["K-2"], cat["K-3"])
	}
	// The created category has the mapped attribute as text.
	if sw := categoryList(t, api)["switch_actuators"]; sw.Name["en"] != "Switch actuators" || len(sw.Attributes) != 1 || sw.Attributes[0]["key"] != "channels" {
		t.Errorf("created category %+v", sw)
	}

	again := upload(t, api, "knx.csv", data, profile)
	if again.Counts.Products != (imports.ImportCounter{Unchanged: 3}) || again.Counts.Variants != (imports.ImportCounter{Unchanged: 3}) ||
		again.Counts.Categories.New != 0 {
		t.Errorf("re-import counts %+v", again.Counts)
	}
	for _, it := range items(t, api, again.ID.String(), "") {
		if it.Status != "unchanged" {
			t.Errorf("re-import item %+v", it)
		}
	}
}

// The starter profile needs the product type "zigbee": without it the
// preview is refused at the profile's constant (the import never creates
// product types).
func TestStarterNeedsZigbee(t *testing.T) {
	api := apptest.New(t)
	var profile string
	for _, p := range decode[[]imports.ImportProfile](t, api.Get("/api/import-profiles", api.Admin.Cookie)) {
		profile = p.ID.String()
	}
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), "")
	p := assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{"profileId": profile}),
		http.StatusUnprocessableEntity, "validation.failed")
	if !reflect.DeepEqual(fieldCodes(p), []string{"mapping.fields[0].value import.product_type_unknown"}) || p.Fields[0].Params["value"] != "zigbee" {
		t.Errorf("fields %+v", p.Fields)
	}
	// Created afterwards, the same run previews.
	newProductType(t, api, "zigbee", "ZB")
	if run := preview(t, api, run.ID.String(), map[string]any{"profileId": profile}); run.Counts.Errors != 0 {
		t.Errorf("counts %+v", run.Counts)
	}
}

func TestProfiles(t *testing.T) {
	api := apptest.New(t)
	newProductType(t, api, "zigbee", "ZB")
	list := decode[[]imports.ImportProfile](t, api.Get("/api/import-profiles", api.Admin.Cookie))
	if len(list) != 1 || list[0].Name != imports.StarterProfileName || !reflect.DeepEqual(list[0].Mapping, imports.StarterMapping()) {
		t.Fatalf("starter %+v", list)
	}
	// Deleting it leaves no profile; it comes back when the list is empty.
	expect(t, api.Delete("/api/import-profiles/"+list[0].ID.String(), api.Admin.Cookie), http.StatusNoContent)
	assertError(t, api.Delete("/api/import-profiles/"+list[0].ID.String(), api.Admin.Cookie), http.StatusNotFound, "import_profile.not_found")

	m := imports.StarterMapping()
	resp := api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "  Supplier A  ", "mapping": m})
	expect(t, resp, http.StatusCreated)
	p := decode[imports.ImportProfile](t, resp)
	if p.Name != "Supplier A" || !p.Can.Update {
		t.Errorf("profile %+v", p)
	}
	if got := decode[[]imports.ImportProfile](t, api.Get("/api/import-profiles", api.Admin.Cookie)); len(got) != 1 {
		t.Errorf("list %d (the starter is only created when there is none)", len(got))
	}
	pr := assertError(t, api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "supplier a", "mapping": m}), http.StatusConflict, "import_profile.name_taken")
	if pr.Params["name"] != "supplier a" {
		t.Errorf("params %v", pr.Params)
	}

	bad := imports.ImportMapping{SourceKind: "xlsx", HeaderRow: 3, DataStartRow: 3, Fields: []imports.ImportField{
		{Target: "product.colour", Column: "A"},
		{Target: "product.name.fr", Column: "B"},
		{Target: "variant.sku", Value: str("x")},
		{Target: "variant.price"},
		{Target: "variant.price", Column: "Price", Value: str("1")},
		{Target: "attribute.Bad-Key", Value: str("1")},
		{Target: "addon.required", ColumnLetter: "A1"},
		{Target: "addon.required", ColumnLetter: "b"},
	}}
	pr = assertError(t, api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "", "mapping": bad}), http.StatusUnprocessableEntity, "validation.failed")
	want := []string{
		"body.name validation.required",
		"body.mapping.dataStartRow import_profile.data_start_row",
		"body.mapping.fields[0].target import_profile.target_unknown",
		"body.mapping.fields[1].target import_profile.target_unknown",
		"body.mapping.fields[2].value import_profile.constant_not_allowed",
		"body.mapping.fields[3] import_profile.source_required",
		"body.mapping.fields[4].target import_profile.target_duplicate",
		"body.mapping.fields[4] import_profile.source_conflict",
		"body.mapping.fields[5].target import_profile.target_unknown",
		"body.mapping.fields[6].columnLetter import_profile.column_letter",
		"body.mapping.fields import_profile.model_number_required",
		"body.mapping.fields import_profile.product_type_required",
		"body.mapping.fields import_profile.category_required",
	}
	if !reflect.DeepEqual(fieldCodes(pr), want) {
		t.Errorf("fields\n%v\nwant\n%v", fieldCodes(pr), want)
	}
	missing := "00000000-0000-0000-0000-000000000001"
	m2 := imports.StarterMapping()
	m2.ProductTypeID, m2.CategoryID = ptr(missing), ptr(missing)
	pr = assertError(t, api.Post("/api/import-profiles", api.Admin.Cookie, map[string]any{"name": "B", "mapping": m2}), http.StatusUnprocessableEntity, "validation.failed")
	if !reflect.DeepEqual(fieldCodes(pr), []string{
		"body.mapping.productTypeId product.type_not_found", "body.mapping.categoryId product.category_not_found",
		"body.mapping.productTypeId import_profile.product_type_conflict", "body.mapping.categoryId import_profile.category_conflict",
	}) {
		t.Errorf("fields %v", fieldCodes(pr))
	}

	// Update with optimistic concurrency.
	m.HeaderRow = 2
	resp = api.Put("/api/import-profiles/"+p.ID.String(), api.Admin.Cookie, map[string]any{"name": "Supplier A", "mapping": m, "expectedUpdatedAt": p.UpdatedAt})
	expect(t, resp, http.StatusOK)
	updated := decode[imports.ImportProfile](t, resp)
	if updated.Mapping.HeaderRow != 2 || !updated.UpdatedAt.After(p.UpdatedAt) {
		t.Errorf("updated %+v", updated)
	}
	assertError(t, api.Put("/api/import-profiles/"+p.ID.String(), api.Admin.Cookie, map[string]any{"name": "Supplier A", "mapping": m, "expectedUpdatedAt": p.UpdatedAt}),
		http.StatusConflict, "import_profile.stale")
	assertError(t, api.Put("/api/import-profiles/"+missing, api.Admin.Cookie, map[string]any{"name": "X", "mapping": m, "expectedUpdatedAt": p.UpdatedAt}),
		http.StatusNotFound, "import_profile.not_found")
	assertError(t, api.Get("/api/import-profiles/"+missing, api.Admin.Cookie), http.StatusNotFound, "import_profile.not_found")
	if got := decode[imports.ImportProfile](t, api.Get("/api/import-profiles/"+p.ID.String(), api.Admin.Cookie)); got.Mapping.HeaderRow != 2 {
		t.Errorf("get %+v", got)
	}

	// A run keeps its copy of the mapping when the profile is deleted.
	run := upload(t, api, "a.xlsx", workbook(t, v1Rows(t)), "")
	m.HeaderRow = 3
	resp = api.Put("/api/import-profiles/"+p.ID.String(), api.Admin.Cookie, map[string]any{"name": "Supplier A", "mapping": m, "expectedUpdatedAt": updated.UpdatedAt})
	expect(t, resp, http.StatusOK)
	run = preview(t, api, run.ID.String(), map[string]any{"profileId": p.ID})
	expect(t, api.Delete("/api/import-profiles/"+p.ID.String(), api.Admin.Cookie), http.StatusNoContent)
	got := decode[imports.ImportRun](t, api.Get("/api/imports/"+run.ID.String(), api.Admin.Cookie))
	if got.ProfileID != nil || got.ProfileName != "Supplier A" || got.Mapping == nil || got.Mapping.HeaderRow != 3 {
		t.Errorf("run %+v", got)
	}
	assertError(t, api.Post("/api/imports/"+run.ID.String()+"/preview", api.Admin.Cookie, map[string]any{}), http.StatusUnprocessableEntity, "validation.failed")
	assertError(t, api.Get("/api/imports/"+missing, api.Admin.Cookie), http.StatusNotFound, "import.not_found")
}

func ptr(s string) *uuid.UUID { u := uuid.MustParse(s); return &u }

func TestTargets(t *testing.T) {
	api := apptest.New(t)
	a := newCategory(t, api, "a_cat", "", []any{
		map[string]any{"key": "width", "label": map[string]string{"en": "Width"}, "type": "number"},
		map[string]any{"key": "colour", "label": map[string]string{"en": "Colour"}, "type": "text", "scope": "variant"},
	})
	newCategory(t, api, "b_cat", "", []any{map[string]any{"key": "width", "label": map[string]string{"en": "Breite"}, "type": "integer"}})
	list := decode[[]imports.ImportTarget](t, api.Get("/api/import-targets", api.Admin.Cookie))
	byName := map[string]imports.ImportTarget{}
	for _, tg := range list {
		byName[tg.Target] = tg
	}
	if !byName["product.modelNumber"].Required || !byName["addon.required"].Repeatable || !byName["variant.image"].ColumnOptional ||
		byName["variant.sku"].Constant || !byName["product.name.de"].Constant ||
		!byName["product.productType"].Required || !byName["product.productType"].Constant ||
		!byName["product.category"].Required || !byName["product.category"].Constant {
		t.Errorf("fixed targets %+v", list)
	}
	width := byName["attribute.width"]
	if width.Attribute == nil || len(width.Attribute.Categories) != 2 || width.Attribute.Label["en"] != "Width" ||
		width.Attribute.Categories[0].CategoryID.String() != a.ID {
		t.Errorf("width %+v", width)
	}
	only := decode[[]imports.ImportTarget](t, api.Get("/api/import-targets?categoryId="+a.ID, api.Admin.Cookie))
	attrs := []string{}
	for _, tg := range only {
		if tg.Attribute != nil {
			attrs = append(attrs, tg.Target+" "+string(tg.Attribute.Categories[0].Definition.Scope))
		}
	}
	if !reflect.DeepEqual(attrs, []string{"attribute.colour variant", "attribute.width product"}) {
		t.Errorf("attributes %v", attrs)
	}
	assertError(t, api.Get("/api/import-targets?categoryId=nope", api.Admin.Cookie), http.StatusUnprocessableEntity, "validation.failed")
}

// The real SnapFlow 1 workbook (9.3 MB, not in the repository): set
// SNAPFLOW_V1_WORKBOOK to its path to run this test.
func TestRealWorkbook(t *testing.T) {
	p := os.Getenv("SNAPFLOW_V1_WORKBOOK")
	if p == "" {
		t.Skip("SNAPFLOW_V1_WORKBOOK not set")
	}
	data, err := os.ReadFile(p) //nolint:gosec // a test input chosen by the developer
	if err != nil {
		t.Fatal(err)
	}
	api := apptest.New(t)
	profile := starterID(t, api)
	start := time.Now()
	run := upload(t, api, "workbook.xlsx", data, profile)
	t.Logf("upload and first preview: %v", time.Since(start))
	c := run.Counts
	t.Logf("first import: %+v", *c)
	for _, is := range issues(t, api, run.ID.String()) {
		t.Logf("issue %+v", is)
	}
	// SnapFlow 1 imported 79 products, 205 variants and 256 add-on links:
	// it read the add-on columns one position off and skipped column O
	// (Mandatory Addon - 03, 124 references), so 380 is right here. Of the
	// 77 pictures in the file 76 are used: image72 only ever comes second
	// on rows whose first picture is used.
	if c.Products.New != 79 || c.Variants.New != 205 || c.Addons.New != 380 || c.Addons.Unresolved != 0 ||
		c.Images.Files != 76 || c.Images.New != 201 || c.Categories.New != 10 || c.Errors != 0 || c.Warnings != 0 {
		t.Errorf("counts %+v", *c)
	}
	applied := apply(t, api, run.ID.String(), nil)
	if applied.State != imports.StateApplied {
		t.Fatalf("apply %+v", applied)
	}
	if cats := categoryList(t, api); len(cats) != 10 {
		t.Errorf("categories %d", len(cats))
	}
	required, optional := 0, 0
	for _, p := range catalog(t, api) {
		if p.ProductType.Key != "zigbee" {
			t.Errorf("%s is on %q, not zigbee", p.ModelNumber, p.ProductType.Key)
		}
		for _, v := range p.Variants {
			for _, a := range v.Addons {
				if a.Required {
					required++
				} else {
					optional++
				}
			}
		}
	}
	if required != 284 || optional != 96 {
		t.Errorf("add-ons: %d required, %d optional", required, optional)
	}
	start = time.Now()
	again := upload(t, api, "workbook.xlsx", data, profile)
	t.Logf("re-import upload and preview: %v", time.Since(start))
	c = again.Counts
	t.Logf("re-import: %+v", *c)
	if c.Products.Unchanged != 79 || c.Variants.Unchanged != 205 || c.Addons.Unchanged != 380 || c.Images.Unchanged != 201 || c.Products.New+c.Products.Changed+c.Variants.New+c.Variants.Changed != 0 {
		t.Errorf("re-import counts %+v", *c)
	}
}

// "All or nothing" sent as false in a mapping stays false (the default on
// applies only when it is left out).
func TestAllOrNothingOff(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	run := upload(t, api, "a.csv", csvFile("Model;Name", "X-1;Thing"), "")
	mapping := map[string]any{
		"sourceKind": "csv", "headerRow": 1, "dataStartRow": 2, "productTypeId": pt.ID, "createMissingCategories": true,
		"fields": []any{
			map[string]any{"target": "product.modelNumber", "column": "Model"},
			map[string]any{"target": "product.name.en", "column": "Name"},
			map[string]any{"target": "product.category", "value": "Things"},
		},
	}
	if got := preview(t, api, run.ID.String(), map[string]any{"mapping": mapping}); !got.AllOrNothing || !got.Mapping.AllOrNothing {
		t.Errorf("left out: %v %v, want on", got.AllOrNothing, got.Mapping.AllOrNothing)
	}
	mapping["allOrNothing"] = false
	if got := preview(t, api, run.ID.String(), map[string]any{"mapping": mapping}); got.AllOrNothing || got.Mapping.AllOrNothing {
		t.Errorf("sent false: %v %v, want off", got.AllOrNothing, got.Mapping.AllOrNothing)
	}
}
