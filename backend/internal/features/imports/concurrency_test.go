package imports_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
)

// pauseFirstWrite makes the first apply write wait until release is
// closed; paused reports when it waits. Its snapshot is taken by then.
func pauseFirstWrite(t *testing.T) (paused func() bool, release chan struct{}) {
	t.Helper()
	release = make(chan struct{})
	var blocked atomic.Bool
	t.Cleanup(imports.SetFailHook(func(imports.ImportItem) error {
		if blocked.CompareAndSwap(false, true) {
			<-release
		}
		return nil
	}))
	return blocked.Load, release
}

// waitFor polls until cond holds (at most 5 s).
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for range 1000 {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// waitingOnLock reports whether a session waits for a lock.
func waitingOnLock(t *testing.T, api *apptest.API) bool {
	var n int
	if err := api.DB.QueryRow(t.Context(), "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n > 0
}

func postAsync(api *apptest.API, wg *sync.WaitGroup, path string, out **httptest.ResponseRecorder) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		*out = api.Post(path, api.Admin.Cookie, map[string]any{})
	}()
}

// Two runs of the same file applied at once: the second waits for the
// first and then sees its writes (a fresh snapshot), so it is stale
// instead of failing on taken model numbers (D146).
func TestConcurrentApplies(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	data := csvFile("Model;Name;Variant;Price", "C-1;One;;1", "C-2;Two;;2")
	m := csvMapping(pt.ID, cat.ID)
	a := upload(t, api, "a.csv", data, "")
	preview(t, api, a.ID.String(), map[string]any{"mapping": m})
	b := upload(t, api, "b.csv", data, "")
	preview(t, api, b.ID.String(), map[string]any{"mapping": m})

	paused, release := pauseFirstWrite(t)
	var wg sync.WaitGroup
	var respA, respB *httptest.ResponseRecorder
	postAsync(api, &wg, "/api/imports/"+a.ID.String()+"/apply", &respA)
	waitFor(t, "A's first write", paused)
	postAsync(api, &wg, "/api/imports/"+b.ID.String()+"/apply", &respB)
	waitFor(t, "B waiting for A", func() bool { return waitingOnLock(t, api) })
	close(release)
	wg.Wait()
	if respA.Code != http.StatusOK || decode[imports.ImportRun](t, respA).State != imports.StateApplied {
		t.Fatalf("A: %d %s", respA.Code, respA.Body)
	}
	if respB.Code != http.StatusConflict || decode[problem](t, respB).Code != "import.stale" {
		t.Fatalf("B: %d %s", respB.Code, respB.Body)
	}
	if r := decode[imports.ImportRun](t, api.Get("/api/imports/"+b.ID.String(), api.Admin.Cookie)); r.State != imports.StatePreviewed {
		t.Errorf("B is %s", r.State)
	}
}

// Two runs that set the add-on list of the same variant: the lists are
// never merged; the second is stale.
func TestConcurrentAddonLists(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	frames := newCategory(t, api, "frames", "", nil)
	r := upload(t, api, "x.csv", csvFile("Model;Name;Variant;SKU;Price", "X-1;X;;X1;1", "Y-1;Y;;Y1;1"), "")
	preview(t, api, r.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, frames.ID, skuField)})
	apply(t, api, r.ID.String(), nil)

	m := csvMapping(pt.ID, cat.ID, skuField, addonField)
	a := upload(t, api, "a.csv", csvFile("Model;Name;Variant;SKU;Price;Addon", "V-1;V;;V1;5;X1"), "")
	b := upload(t, api, "b.csv", csvFile("Model;Name;Variant;SKU;Price;Addon", "V-1;V;;V1;5;Y1"), "")
	r = upload(t, api, "v.csv", csvFile("Model;Name;Variant;SKU;Price", "V-1;V;;V1;5"), "")
	preview(t, api, r.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField)})
	apply(t, api, r.ID.String(), nil)
	preview(t, api, a.ID.String(), map[string]any{"mapping": m})
	preview(t, api, b.ID.String(), map[string]any{"mapping": m})

	paused, release := pauseFirstWrite(t)
	var wg sync.WaitGroup
	var respA, respB *httptest.ResponseRecorder
	postAsync(api, &wg, "/api/imports/"+a.ID.String()+"/apply", &respA)
	waitFor(t, "A's first write", paused)
	postAsync(api, &wg, "/api/imports/"+b.ID.String()+"/apply", &respB)
	waitFor(t, "B waiting for A", func() bool { return waitingOnLock(t, api) })
	close(release)
	wg.Wait()
	if respA.Code != http.StatusOK || respB.Code != http.StatusConflict || decode[problem](t, respB).Code != "import.stale" {
		t.Fatalf("A: %d, B: %d %s", respA.Code, respB.Code, respB.Body)
	}
	v := catalog(t, api)["V-1"].Variants[0]
	if len(v.Addons) != 1 || v.Addons[0].ModelNumber != "X-1" {
		t.Errorf("V-1 add-ons %+v", v.Addons)
	}
}

// A user replaces an add-on list while an apply that sets it runs: the
// apply (whose snapshot is older) is stale; the user's list stays alone.
func TestApplyAgainstAddonEdit(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	frames := newCategory(t, api, "frames", "", nil)
	r := upload(t, api, "x.csv", csvFile("Model;Name;Variant;SKU;Price", "X-1;X;;X1;1", "Y-1;Y;;Y1;1"), "")
	preview(t, api, r.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, frames.ID, skuField)})
	apply(t, api, r.ID.String(), nil)
	r = upload(t, api, "v.csv", csvFile("Model;Name;Variant;SKU;Price", "V-1;V;;V1;5", "W-1;W;;W1;5"), "")
	preview(t, api, r.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField)})
	apply(t, api, r.ID.String(), nil)

	// W-1's row comes first: the apply pauses there, before V-1's list.
	run := upload(t, api, "a.csv", csvFile("Model;Name;Variant;SKU;Price;Addon", "W-1;W;;W1;6;", "V-1;V;;V1;5;X1"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID, skuField, addonField)})
	paused, release := pauseFirstWrite(t)
	var wg sync.WaitGroup
	var resp *httptest.ResponseRecorder
	postAsync(api, &wg, "/api/imports/"+run.ID.String()+"/apply", &resp)
	waitFor(t, "the apply's first write", paused)
	c := catalog(t, api)
	setAddons(t, api, c["V-1"].ID, c["V-1"].Variants[0].ID, c["Y-1"].Variants[0].ID)
	close(release)
	wg.Wait()
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "import.stale" {
		t.Fatalf("apply: %d %s", resp.Code, resp.Body)
	}
	c = catalog(t, api)
	if v := c["V-1"].Variants[0]; len(v.Addons) != 1 || v.Addons[0].ModelNumber != "Y-1" {
		t.Errorf("V-1 add-ons %+v", v.Addons)
	}
	if c["W-1"].Variants[0].Price != "5.00" {
		t.Error("the stale apply wrote")
	}
}

// A product the run created is edited while its undo runs: the undo
// (whose snapshot is older) finds the conflict instead of deleting it.
func TestUndoAgainstEdit(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	run := upload(t, api, "a.csv", csvFile("Model;Name;Variant;Price", "U-1;U;;5"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID)})
	apply(t, api, run.ID.String(), nil)

	release := make(chan struct{})
	var blocked atomic.Bool
	defer imports.SetUndoHook(func() {
		if blocked.CompareAndSwap(false, true) {
			<-release
		}
	})()
	var wg sync.WaitGroup
	var resp *httptest.ResponseRecorder
	postAsync(api, &wg, "/api/imports/"+run.ID.String()+"/undo", &resp)
	waitFor(t, "the undo's checks", blocked.Load)
	renameProduct(t, api, catalog(t, api)["U-1"], "Edited")
	close(release)
	wg.Wait()
	p := decode[problem](t, resp)
	if resp.Code != http.StatusConflict || p.Code != "import.undo_conflict" {
		t.Fatalf("undo: %d %s", resp.Code, resp.Body)
	}
	if _, ok := catalog(t, api)["U-1"]; !ok {
		t.Error("the edited product was deleted")
	}
}

// The apply runs to its end when the client goes away (D151): the run is
// applied, nothing is rolled back.
func TestApplyClientGone(t *testing.T) {
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	run := upload(t, api, "a.csv", csvFile("Model;Name;Variant;Price", "C-1;One;;1", "C-2;Two;;2"), "")
	preview(t, api, run.ID.String(), map[string]any{"mapping": csvMapping(pt.ID, cat.ID)})
	ctx, cancel := context.WithCancel(context.Background())
	defer imports.SetFailHook(func(imports.ImportItem) error {
		cancel() // the client disconnects during the apply
		return nil
	})()
	resp := api.PostCtx(ctx, "/api/imports/"+run.ID.String()+"/apply", api.Admin.Cookie, map[string]any{})
	var got imports.ImportRun
	_ = json.Unmarshal(resp.Body.Bytes(), &got)
	if r := decode[imports.ImportRun](t, api.Get("/api/imports/"+run.ID.String(), api.Admin.Cookie)); r.State != imports.StateApplied {
		t.Fatalf("run %s (response %d %s)", r.State, resp.Code, resp.Body)
	}
	if len(catalog(t, api)) != 2 {
		t.Error("the apply was rolled back")
	}
}
