package imports_test

import (
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/imports"
)

// 20 000 rows: 10 000 products with two variants each, one with an add-on.
// Slow, so only with SNAPFLOW_BIG_IMPORT set; it logs each step's time
// (D152: the apply should take well under 10 s).
func TestBigImport(t *testing.T) {
	if os.Getenv("SNAPFLOW_BIG_IMPORT") == "" {
		t.Skip("SNAPFLOW_BIG_IMPORT not set")
	}
	api := apptest.New(t)
	pt := newProductType(t, api, "knx", "KNX")
	cat := newCategory(t, api, "dimmer", "", nil)
	lines := []string{"Model;Name;Variant;SKU;Price;Addon"}
	for i := range imports.MaxRows / 2 {
		lines = append(lines, fmt.Sprintf("M-%d;Name %d;White;S-%d-W;%d,50;S-%d-B", i, i, i, i, i),
			fmt.Sprintf("M-%d;Name %d;Black;S-%d-B;%d,50;", i, i, i, i))
	}
	data := csvFile(lines...)
	m := csvMapping(pt.ID, cat.ID, skuField, addonField)
	step := func(name string, f func()) time.Duration {
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		start := time.Now()
		f()
		took := time.Since(start)
		runtime.ReadMemStats(&after)
		t.Logf("%s: %v, allocated %d MB", name, took.Round(time.Millisecond), (after.TotalAlloc-before.TotalAlloc)>>20)
		return took
	}
	var run imports.ImportRun
	step("upload", func() { run = upload(t, api, "big.csv", data, "") })
	step("preview", func() { run = preview(t, api, run.ID.String(), map[string]any{"mapping": m}) })
	if run.Counts.Products.New != imports.MaxRows/2 || run.Counts.Addons.New != imports.MaxRows/2 || run.Counts.Errors != 0 {
		t.Fatalf("counts %+v", run.Counts)
	}
	took := step("apply", func() { run = apply(t, api, run.ID.String(), nil) })
	if run.Applied.Variants.New != imports.MaxRows || took > 10*time.Second {
		t.Errorf("applied %+v in %v", run.Applied.Variants, took)
	}
	step("re-upload", func() { run = upload(t, api, "big.csv", data, "") })
	step("re-preview", func() { run = preview(t, api, run.ID.String(), map[string]any{"mapping": m}) })
	if run.Counts.Variants.Unchanged != imports.MaxRows || run.Counts.Addons.Unchanged != imports.MaxRows/2 {
		t.Errorf("re-preview %+v %+v", run.Counts.Variants, run.Counts.Addons)
	}
	step("items page", func() { items(t, api, run.ID.String(), "changedOnly=true") })
	step("apply unchanged", func() { apply(t, api, run.ID.String(), nil) })
	step("undo", func() { undo(t, api, run.ID.String()) })
}
