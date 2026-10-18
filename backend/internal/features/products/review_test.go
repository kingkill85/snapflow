package products_test

import (
	"fmt"
	"math/rand/v2"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
)

// rounds of the concurrency tests: enough to hit the lock races reliably.
const rounds = 100

func addonsPath(v variant) string {
	return "/api/products/" + v.ProductID + "/variants/" + v.ID + "/addons"
}

func addonList(vs ...variant) map[string]any {
	list := []any{}
	for _, v := range vs {
		list = append(list, map[string]any{"addonVariantId": v.ID})
	}
	return map[string]any{"addons": list}
}

// checkCodes fails on any status outside allowed (a 500 above all), with
// the body of the first offender.
func checkCodes(t *testing.T, what string, got map[int]int, allowed ...int) {
	t.Helper()
	ok := map[int]bool{}
	for _, c := range allowed {
		ok[c] = true
	}
	for c, n := range got {
		if !ok[c] {
			t.Errorf("%s: %d responses with status %d (all: %v)", what, n, c, got)
		}
	}
}

type tally struct {
	mu    sync.Mutex
	codes map[string]map[int]int
	t     *testing.T
}

func (ta *tally) add(what string, code int, body string) {
	ta.mu.Lock()
	defer ta.mu.Unlock()
	if ta.codes == nil {
		ta.codes = map[string]map[int]int{}
	}
	if ta.codes[what] == nil {
		ta.codes[what] = map[int]int{}
	}
	if code >= 500 && ta.codes[what][code] == 0 {
		ta.t.Errorf("%s: %d %s", what, code, body)
	}
	ta.codes[what][code]++
}

// Reorders lock the product, then its variants FOR NO KEY UPDATE; add-on
// replaces share the product, then lock their variant and the add-ons. Run
// side by side they never deadlock, and nothing ever answers 500.
func TestConcurrentReorderAndAddons(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	p := newProduct(t, api, productBody(pt, "P"))
	q := newProduct(t, api, productBody(pt, "Q"))
	pv := []variant{quickVariant(t, api, p.ID, "1"), quickVariant(t, api, p.ID, "1"), quickVariant(t, api, p.ID, "1"), quickVariant(t, api, p.ID, "1")}
	qv := []variant{quickVariant(t, api, q.ID, "1"), quickVariant(t, api, q.ID, "1"), quickVariant(t, api, q.ID, "1")}
	ids := func(vs []variant) []string {
		out := make([]string, len(vs))
		for i, v := range vs {
			out[i] = v.ID
		}
		rand.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
		return out
	}

	for range 6 {
		pv = append(pv, quickVariant(t, api, p.ID, "1"))
		qv = append(qv, quickVariant(t, api, q.ID, "1"))
	}

	ta := &tally{t: t}
	for range rounds {
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, prod := range []struct {
			id string
			vs []variant
		}{{p.ID, pv}, {q.ID, qv}} {
			wg.Go(func() {
				<-start
				resp := api.Put("/api/products/"+prod.id+"/variants/order", api.Admin.Cookie, map[string]any{"ids": ids(prod.vs)})
				ta.add("reorder", resp.Code, resp.Body.String())
			})
		}
		for _, job := range []struct {
			v      variant
			addons []variant
		}{
			{pv[0], []variant{qv[0], qv[1], pv[1]}},
			{qv[0], []variant{pv[0], pv[2], qv[1]}},
			{pv[1], []variant{qv[2], pv[0], pv[3]}},
			{qv[1], []variant{pv[1], qv[2]}},
			{pv[4], qv[3:]},
			{qv[4], pv[3:]},
		} {
			wg.Go(func() {
				<-start
				resp := api.Put(addonsPath(job.v), api.Admin.Cookie, addonList(job.addons...))
				ta.add("replace", resp.Code, resp.Body.String())
			})
		}
		close(start)
		wg.Wait()
	}
	checkCodes(t, "reorder", ta.codes["reorder"], http.StatusOK)
	checkCodes(t, "replace", ta.codes["replace"], http.StatusOK)
	t.Logf("status counts: %v", ta.codes)

	// Every replace landed whole: no duplicates, the last list of each.
	got := getProduct(t, api, p.ID)
	for _, v := range got.Variants {
		if v.ID == pv[0].ID && len(v.Addons) != 3 {
			t.Errorf("p0 add-ons: %+v", v.Addons)
		}
	}
}

// A product delete removes variants other replaces lock as add-ons, in its
// own order, so deadlocks happen; they are retried (or end as 409
// request.conflict_retry), never as a 500.
func TestConcurrentDeleteAndAddons(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	host := newProduct(t, api, productBody(pt, "HOST"))
	hosts := make([]variant, 4)
	for i := range hosts {
		hosts[i] = quickVariant(t, api, host.ID, "1")
	}
	const perProduct = 12

	ta := &tally{t: t}
	for i := range rounds {
		gone := newProduct(t, api, productBody(pt, fmt.Sprintf("GONE-%d", i)))
		g := make([]variant, perProduct)
		for j := range g {
			g[j] = quickVariant(t, api, gone.ID, "1")
		}
		// Links into the doomed product, so its delete cascades through
		// rows the replaces lock.
		if resp := api.Put(addonsPath(hosts[0]), api.Admin.Cookie, addonList(g...)); resp.Code != http.StatusOK {
			t.Fatal(resp.Body)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, h := range hosts {
			wg.Go(func() {
				list := append([]variant{}, g...)
				rand.Shuffle(len(list), func(i, j int) { list[i], list[j] = list[j], list[i] })
				<-start
				resp := api.Put(addonsPath(h), api.Admin.Cookie, addonList(list...))
				ta.add("replace host", resp.Code, resp.Body.String())
			})
		}
		for _, v := range g[:3] {
			wg.Go(func() {
				<-start
				resp := api.Put(addonsPath(v), api.Admin.Cookie, addonList(hosts...))
				ta.add("replace gone", resp.Code, resp.Body.String())
			})
		}
		wg.Go(func() {
			<-start
			resp := api.Delete("/api/products/"+gone.ID, api.Admin.Cookie)
			ta.add("delete", resp.Code, resp.Body.String())
		})
		close(start)
		wg.Wait()
	}
	// 422: the add-ons were deleted first (addon.variant_not_found); 404:
	// the variant itself was.
	checkCodes(t, "replace host", ta.codes["replace host"], http.StatusOK, http.StatusUnprocessableEntity, http.StatusConflict)
	checkCodes(t, "replace gone", ta.codes["replace gone"], http.StatusOK, http.StatusNotFound, http.StatusConflict)
	checkCodes(t, "delete", ta.codes["delete"], http.StatusNoContent, http.StatusConflict)

	var n int
	if err := api.DB.QueryRow(t.Context(), `SELECT count(*) FROM products WHERE model_number LIKE 'GONE-%'`).Scan(&n); err != nil || n != ta.codes["delete"][http.StatusConflict] {
		t.Errorf("%d deleted products left (%v), %d deletes gave up", n, err, ta.codes["delete"][http.StatusConflict])
	}
	t.Logf("status counts: %v", ta.codes)
}

func TestBusinessKeyText(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})

	// Control and format characters are refused.
	for _, model := range []string{"M1\tX", "M1\nX", "M1\u200bX", "M1\u202eX", "M1\x00X"} {
		assertFields(t, api.Post("/api/products", api.Admin.Cookie, productBody(pt, model)),
			"body.modelNumber validation.control_chars")
	}
	p := newProduct(t, api, productBody(pt, "M1"))
	for _, sku := range []string{"S\t1", "S\r\n1", "S\u2060"} {
		b := variantBody("bad sku", "1")
		b["sku"] = sku
		assertFields(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, b), "body.sku validation.control_chars")
	}

	// NFC: a decomposed \u00e9 is stored composed and is the same key as a
	// composed one.
	decomposed := newProduct(t, api, productBody(pt, " Cafe\u0301-1 "))
	if decomposed.ModelNumber != "Caf\u00e9-1" {
		t.Errorf("model number %q, want NFC", decomposed.ModelNumber)
	}
	assertError(t, api.Post("/api/products", api.Admin.Cookie, productBody(pt, "CAF\u00c9-1")), http.StatusConflict, "product.model_number_taken")

	b := variantBody("nfc", "1")
	b["sku"] = "Sku-Cafe\u0301"
	if v := newVariant(t, api, p.ID, b); v.SKU != "Sku-Caf\u00e9" {
		t.Errorf("sku %q, want NFC", v.SKU)
	}
	b = variantBody("nfc 2", "1")
	b["sku"] = "SKU-CAF\u00c9"
	assertError(t, api.Post("/api/products/"+p.ID+"/variants", api.Admin.Cookie, b), http.StatusConflict, "variant.sku_taken")
}

func TestInactiveType(t *testing.T) {
	api := apptest.New(t)
	active := newType(t, api, "active", []any{})
	old := newType(t, api, "old", []any{})
	other := newType(t, api, "other_old", []any{})
	p := newProduct(t, api, productBody(old, "KEEP"))
	q := newProduct(t, api, productBody(active, "MOVE"))
	setTypeActive(t, api, old, false)
	setTypeActive(t, api, other, false)

	// New products cannot use an inactive type.
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, productBody(old, "NEW")),
		"body.productTypeId product.type_inactive")
	// An existing product keeps its own inactive type...
	if resp := update(api, p, productBody(old, "KEEP")); resp.Code != http.StatusOK {
		t.Errorf("keep inactive type: got %d: %s", resp.Code, resp.Body)
	}
	// ...but cannot move to another inactive one, from an active or an
	// inactive type.
	assertFields(t, update(api, q, productBody(old, "MOVE")), "body.productTypeId product.type_inactive")
	p = getProduct(t, api, p.ID)
	assertFields(t, update(api, p, productBody(other, "KEEP")), "body.productTypeId product.type_inactive")
}

func TestInactiveCategory(t *testing.T) {
	api := apptest.New(t)
	active := newType(t, api, "active", []any{})
	old := newType(t, api, "old", []any{})
	other := newType(t, api, "other_old", []any{})
	p := newProduct(t, api, productBody(old, "KEEP"))
	q := newProduct(t, api, productBody(active, "MOVE"))
	updateCategory(t, api, old, []any{}, false)
	updateCategory(t, api, other, []any{}, false)
	withCategory := func(k kind, categoryID string) kind { return kind{ID: k.ID, CategoryID: categoryID} }

	// New products cannot use an inactive category.
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, productBody(withCategory(active, old.CategoryID), "NEW")),
		"body.categoryId product.category_inactive")
	// An existing product keeps its own inactive category, also with another
	// (active) product type...
	if resp := update(api, p, productBody(withCategory(active, old.CategoryID), "KEEP")); resp.Code != http.StatusOK {
		t.Errorf("keep inactive category: got %d: %s", resp.Code, resp.Body)
	}
	// ...but cannot move to another inactive one, from an active or an
	// inactive category.
	assertFields(t, update(api, q, productBody(withCategory(active, old.CategoryID), "MOVE")), "body.categoryId product.category_inactive")
	p = getProduct(t, api, p.ID)
	assertFields(t, update(api, p, productBody(withCategory(active, other.CategoryID), "KEEP")), "body.categoryId product.category_inactive")
	// Both problems at once.
	setTypeActive(t, api, other, false)
	assertFields(t, api.Post("/api/products", api.Admin.Cookie, productBody(other, "NEW")),
		"body.productTypeId product.type_inactive", "body.categoryId product.category_inactive")
}

// Catalog order is product type order, then category order, then model
// number; the product list and the variant search filter by either or both.
func TestCatalogOrderAndFilters(t *testing.T) {
	api := apptest.New(t)
	zigbee, knx := newProductType(t, api, "zigbee"), newProductType(t, api, "knx")
	gateways, dimmers := newCategory(t, api, "gateways", []any{}), newCategory(t, api, "dimmers", []any{})
	add := func(pt productType, c category, model string) {
		p := newProduct(t, api, productBody(kind{ID: pt.ID, CategoryID: c.ID}, model))
		quickVariant(t, api, p.ID, "1")
	}
	add(knx, gateways, "K-GW")
	add(zigbee, dimmers, "Z-DIM-B")
	add(knx, dimmers, "K-DIM")
	add(zigbee, gateways, "Z-GW")
	add(zigbee, dimmers, "z-dim-a")

	hits := func(query string) []string {
		t.Helper()
		out := []string{}
		for _, h := range decode[variantPage](t, api.Get("/api/variants"+query, api.Admin.Cookie)).Items {
			out = append(out, h.ModelNumber)
		}
		return out
	}
	check := func(step string, want []string, filters ...string) {
		t.Helper()
		query := ""
		if len(filters) > 0 {
			query = "?" + strings.Join(filters, "&")
		}
		if got := models(list(t, api, api.Admin.Cookie, query)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: products %v, want %v", step, got, want)
		}
		if got := hits(query); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: variants %v, want %v", step, got, want)
		}
	}
	check("catalog order", []string{"Z-GW", "z-dim-a", "Z-DIM-B", "K-GW", "K-DIM"})
	check("type filter", []string{"K-GW", "K-DIM"}, "productTypeId="+knx.ID)
	check("category filter", []string{"z-dim-a", "Z-DIM-B", "K-DIM"}, "categoryId="+dimmers.ID)
	check("both filters", []string{"z-dim-a", "Z-DIM-B"}, "productTypeId="+zigbee.ID, "categoryId="+dimmers.ID)

	// Reordering categories changes the order within each type.
	if resp := api.Put("/api/categories/order", api.Admin.Cookie, map[string]any{"ids": []string{dimmers.ID, gateways.ID}}); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	check("category order", []string{"z-dim-a", "Z-DIM-B", "Z-GW", "K-DIM", "K-GW"})
	// Product type order comes first.
	if resp := api.Put("/api/product-types/order", api.Admin.Cookie, map[string]any{"ids": []string{knx.ID, zigbee.ID}}); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	check("type order", []string{"K-DIM", "K-GW", "z-dim-a", "Z-DIM-B", "Z-GW"})
	if resp := api.Get("/api/variants?categoryId=nope", api.Admin.Cookie); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad category id: got %d", resp.Code)
	}
}

// A category change never refuses because of the variants: their values are
// flagged against the new category and summarised in variantsWithProblems.
func TestCategoryChangeFlagsVariants(t *testing.T) {
	api := apptest.New(t)
	free := newType(t, api, "free", []any{})
	strict := newType(t, api, "strict", []any{
		map[string]any{"key": "colour", "label": text("Colour"), "type": "text", "scope": "variant", "required": true},
	})
	p := newProduct(t, api, productBody(free, "M1"))
	quickVariant(t, api, p.ID, "1")
	quickVariant(t, api, p.ID, "2")
	if got := getProduct(t, api, p.ID); got.VariantsWithProblems != 0 {
		t.Errorf("before: %d", got.VariantsWithProblems)
	}
	resp := update(api, p, productBody(kind{ID: free.ID, CategoryID: strict.CategoryID}, "M1"))
	if resp.Code != http.StatusOK {
		t.Fatalf("category change: got %d: %s", resp.Code, resp.Body)
	}
	moved := decode[product](t, resp)
	if moved.VariantsWithProblems != 2 ||
		!reflect.DeepEqual(errorLocations(moved.Variants[0].AttributeErrors), []string{"attributes.colour attribute.required"}) {
		t.Errorf("after: %d problems, %+v", moved.VariantsWithProblems, moved.Variants[0].AttributeErrors)
	}
	if got := getProduct(t, api, p.ID); got.VariantsWithProblems != 2 {
		t.Errorf("read: %d", got.VariantsWithProblems)
	}
}

// A stored value whose attribute moved to the other scope stays in
// attributes, flagged attribute.wrong_scope (not stale).
func TestMovedScopeOnRead(t *testing.T) {
	api := apptest.New(t)
	def := map[string]any{"key": "colour", "label": text("Colour"), "type": "text"}
	pt := newType(t, api, "lamp", []any{def})
	b := productBody(pt, "M1")
	b["attributes"] = map[string]any{"colour": "red"}
	p := newProduct(t, api, b)

	moved := map[string]any{"key": "colour", "label": text("Colour"), "type": "text", "scope": "variant"}
	updateCategory(t, api, pt, []any{moved}, true)
	got := getProduct(t, api, p.ID)
	if !reflect.DeepEqual(got.Attributes, map[string]any{"colour": "red"}) || len(got.StaleAttributes) != 0 ||
		!reflect.DeepEqual(errorLocations(got.AttributeErrors), []string{"attributes.colour attribute.wrong_scope"}) {
		t.Errorf("attributes %v stale %v errors %v", got.Attributes, got.StaleAttributes, got.AttributeErrors)
	}
	if items := list(t, api, api.Admin.Cookie, "").Items; items[0].AttributeErrors != 1 || items[0].StaleAttributes != 0 {
		t.Errorf("list counts: %+v", items[0])
	}
}

// Search covers descriptions (en/de), as in SnapFlow 1, in the product
// list and the variant search.
func TestSearchDescriptions(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	b := productBody(pt, "M1")
	b["description"] = map[string]string{"en": "Four channel 100% dimmer", "de": "Vierkanal-Dimmer"}
	p := newProduct(t, api, b)
	quickVariant(t, api, p.ID, "1")
	newProduct(t, api, productBody(pt, "M2"))
	for _, search := range []string{"vierkanal", "FOUR CHANNEL", "100%"} {
		if got := models(list(t, api, api.Admin.Cookie, "?search="+urlEncode(search))); !reflect.DeepEqual(got, []string{"M1"}) {
			t.Errorf("list %q: %v", search, got)
		}
		hits := decode[variantPage](t, api.Get("/api/variants?search="+urlEncode(search), api.Admin.Cookie))
		if hits.Total != 1 || hits.Items[0].ProductID != p.ID {
			t.Errorf("variants %q: %+v", search, hits)
		}
	}
	if got := list(t, api, api.Admin.Cookie, "?search="+urlEncode("0%d")); got.Total != 0 {
		t.Errorf("%% must be literal: %v", models(got))
	}
}

// The add-on picker browses: without a search, every variant in catalog
// order (type order, category order, model number, variant order), paged,
// optionally of one type (TestCatalogOrderAndFilters covers categories).
func TestVariantBrowse(t *testing.T) {
	api := apptest.New(t)
	first := newType(t, api, "first", []any{})
	second := newType(t, api, "second", []any{})
	a := newProduct(t, api, productBody(second, "A1"))
	z := newProduct(t, api, productBody(first, "Z9"))
	b := newProduct(t, api, productBody(second, "b2"))
	a1, a2 := quickVariant(t, api, a.ID, "1"), quickVariant(t, api, a.ID, "1")
	z1 := quickVariant(t, api, z.ID, "1")
	b1 := quickVariant(t, api, b.ID, "1")
	if resp := api.Put("/api/products/"+a.ID+"/variants/order", api.Admin.Cookie, map[string]any{"ids": []string{a2.ID, a1.ID}}); resp.Code != http.StatusOK {
		t.Fatal(resp.Body)
	}
	hitIDs := func(query string) ([]string, int) {
		t.Helper()
		resp := api.Get("/api/variants"+query, api.Admin.Cookie)
		if resp.Code != http.StatusOK {
			t.Fatalf("%s: got %d: %s", query, resp.Code, resp.Body)
		}
		pg := decode[variantPage](t, resp)
		out := []string{}
		for _, h := range pg.Items {
			out = append(out, h.ID)
		}
		return out, pg.Total
	}
	if got, total := hitIDs(""); !reflect.DeepEqual(got, []string{z1.ID, a2.ID, a1.ID, b1.ID}) || total != 4 {
		t.Errorf("browse: %v (%d)", got, total)
	}
	if got, total := hitIDs("?productTypeId=" + second.ID); !reflect.DeepEqual(got, []string{a2.ID, a1.ID, b1.ID}) || total != 3 {
		t.Errorf("type filter: %v (%d)", got, total)
	}
	if got, total := hitIDs("?productTypeId=" + second.ID + "&limit=1&offset=1"); !reflect.DeepEqual(got, []string{a1.ID}) || total != 3 {
		t.Errorf("type filter, page 2: %v (%d)", got, total)
	}
	if got, total := hitIDs("?productTypeId=" + second.ID + "&search=b2"); !reflect.DeepEqual(got, []string{b1.ID}) || total != 1 {
		t.Errorf("type filter and search: %v (%d)", got, total)
	}
	if resp := api.Get("/api/variants?productTypeId=nope", api.Admin.Cookie); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad type id: got %d", resp.Code)
	}
}

// A real deadlock, forced: another transaction (standing in for a product
// delete halfway through its cascade) holds one add-on variant and then
// wants the other, which the replace already locked. Postgres aborts the
// replace (it waited first); inTx runs it again and it succeeds.
func TestDeadlockIsRetried(t *testing.T) {
	api := apptest.New(t)
	pt := newType(t, api, "free", []any{})
	host := quickVariant(t, api, newProduct(t, api, productBody(pt, "HOST")).ID, "1")
	other := newProduct(t, api, productBody(pt, "OTHER"))
	x, y := quickVariant(t, api, other.ID, "1"), quickVariant(t, api, other.ID, "1")
	if x.ID < y.ID { // the replace locks add-ons in id order: y first, then x
		x, y = y, x
	}
	ctx := t.Context()
	tx, err := api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT 1 FROM product_variants WHERE id = $1 FOR UPDATE`, x.ID); err != nil {
		t.Fatal(err)
	}

	done := make(chan int)
	go func() {
		done <- api.Put(addonsPath(host), api.Admin.Cookie, addonList(x, y)).Code
	}()
	// Wait until the replace holds y and waits for x.
	for i := 0; ; i++ {
		var waiting int
		if err := api.DB.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if i > 500 {
			t.Fatal("the replace never waited for the lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Close the cycle. After deadlock_timeout the replace, which waited
	// first, is aborted with 40P01 and this lock is granted.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM product_variants WHERE id = $1 FOR UPDATE`, y.ID); err != nil {
		t.Fatalf("the test transaction lost the deadlock: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if code := <-done; code != http.StatusOK {
		t.Fatalf("replace after a deadlock: got %d", code)
	}
	if got := getProduct(t, api, host.ProductID).Variants[0].Addons; len(got) != 2 {
		t.Errorf("add-ons: %+v", got)
	}
}
