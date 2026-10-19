package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/imports/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// MaxConflicts is how many conflicting entities import.undo_conflict
// names.
const MaxConflicts = 50

// ApplyTimeout bounds an apply or undo. They run detached from the request
// (a client that disconnects or a proxy that times out does not roll them
// back; the run's state shows the result, D151).
const ApplyTimeout = 10 * time.Minute

// applyTx runs apply and undo: REPEATABLE READ, so a concurrent change to
// anything they write aborts them (40001) instead of being overwritten;
// database.InTx runs them again, and the catalog token check then reports
// the preview as stale. Their first statement updates the import_lock row
// (BumpImportLock): that serialises them, and a waiting one gets a
// serialization error once the first commits, so it runs again on a fresh
// snapshot (D146).
var applyTx = pgx.TxOptions{IsoLevel: pgx.RepeatableRead}

// ImportApplyInput are the options of an apply.
type ImportApplyInput struct {
	// AllOrNothing overrides the profile's option for this apply.
	AllOrNothing *bool `json:"allOrNothing,omitempty" doc:"Override the mapping's option: true applies nothing while rows have errors, false skips them"`
}

// failTestHook lets tests make a write fail (export_test.go).
var failTestHook func(item ImportItem) error

// undoTestHook lets tests act between undo's checks and its writes.
var undoTestHook func()

// errRolledBack ends an apply transaction whose write failed (all or
// nothing); the run is then marked failed.
var errRolledBack = errors.New("imports: apply rolled back")

func errStale() error {
	return apperr.Conflict("import.stale", "the catalog changed since the preview; preview again")
}

// staleError reports an error of a write that means the catalog changed
// under the preview (D147): a version moved on, something is gone, or a
// unique key was taken since. The preview checked all of these, so the run
// goes back to the preview (409 import.stale) instead of failing.
func staleError(err error) bool {
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		return false
	}
	codes := []string{ae.Code}
	for _, f := range ae.Fields {
		codes = append(codes, f.Code)
	}
	for _, c := range codes {
		if strings.HasSuffix(c, ".stale") || strings.HasSuffix(c, "not_found") || strings.HasSuffix(c, "_taken") {
			return true
		}
	}
	return false
}

// Apply writes a previewed run's diff in one transaction, through the
// category and product services (all their rules apply). The part of the
// catalog the preview read must be unchanged (import.stale otherwise: run
// the preview again). With all or nothing (the default), a preview with
// row errors is refused (import.has_errors) and a write that fails rolls
// everything back and marks the run failed; otherwise items with errors
// are skipped, and a product whose write fails is skipped with its
// variants and reported as a row error.
func (s *Service) Apply(ctx context.Context, id uuid.UUID, in ImportApplyInput) (ImportRun, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportRun{}, err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ApplyTimeout)
	defer cancel()
	var (
		row     store.ImportRun
		failure *ImportRunError
		counts  runCounts
	)
	err := s.inTx(ctx, applyTx, func(tx pgx.Tx, q *store.Queries) error {
		failure = nil
		if _, err := q.BumpImportLock(ctx); err != nil {
			return err
		}
		run, err := q.LockRun(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if run.State != StatePreviewed {
			return errState(run.State)
		}
		allOrNothing := run.AllOrNothing
		if in.AllOrNothing != nil {
			allOrNothing = *in.AllOrNothing
		}
		if err := json.Unmarshal(run.Counts, &counts); err != nil || counts.Preview == nil {
			return fmt.Errorf("imports: run %s counts: %w", id, err)
		}
		types, cats, err := s.checkToken(ctx, tx, run)
		if err != nil {
			return err
		}
		if allOrNothing && counts.Preview.Errors > 0 {
			return apperr.New(http.StatusUnprocessableEntity, "import.has_errors", "rows have errors").With("count", counts.Preview.Errors)
		}
		planRows, err := q.ListPlan(ctx, id)
		if err != nil {
			return err
		}
		ex := newExecutor(ctx, tx, s, allOrNothing, *counts.Preview, types, cats)
		if err := ex.load(planRows); err != nil {
			return err
		}
		if err := ex.run(); err != nil {
			var ae *apperr.Error
			switch {
			case apperr.IsRetryable(err):
				return err
			case staleError(err):
				return errStale()
			case allOrNothing && errors.As(err, &ae):
				failure = &ImportRunError{Code: ae.Code, Params: ae.Params, Rows: ex.failedRows, Field: ex.failedField}
				if len(ae.Fields) > 0 {
					failure.Code, failure.Params, failure.Field = ae.Fields[0].Code, ae.Fields[0].Params, ae.Fields[0].Location
				}
				return errRolledBack
			}
			return err
		}
		changes, err := changeRows(id, ex.changes)
		if err != nil {
			return err
		}
		if _, err := q.InsertChanges(ctx, changes); err != nil {
			return err
		}
		if len(ex.issues) > 0 {
			first, err := q.MaxIssueSeq(ctx, id)
			if err != nil {
				return err
			}
			issues, err := issueRows(id, ex.issues, int(first))
			if err != nil {
				return err
			}
			if _, err := q.InsertIssues(ctx, issues); err != nil {
				return err
			}
		}
		applied := ex.applied
		counts.Applied = &applied
		data, err := json.Marshal(counts)
		if err != nil {
			return err
		}
		row, err = q.SetRunState(ctx, store.SetRunStateParams{ID: id, State: StateApplied, Counts: data, AllOrNothing: allOrNothing})
		return err
	})
	if errors.Is(err, errRolledBack) {
		data, err := json.Marshal(failure)
		if err != nil {
			return ImportRun{}, err
		}
		countsJSON, err := json.Marshal(runCounts{Preview: counts.Preview})
		if err != nil {
			return ImportRun{}, err
		}
		row, err = s.q.SetRunState(ctx, store.SetRunStateParams{ID: id, State: StateFailed, Counts: countsJSON, Error: data, AllOrNothing: true})
		if err != nil {
			return ImportRun{}, err
		}
		return runOut(row)
	}
	if err != nil {
		return ImportRun{}, err
	}
	return runOut(row)
}

// checkToken compares the part of the catalog the preview read with its
// token (import.stale if it changed) and returns the product types and
// categories read.
func (s *Service) checkToken(ctx context.Context, tx pgx.Tx, run store.ImportRun) (map[uuid.UUID]producttypes.ProductType, map[uuid.UUID]categories.Category, error) {
	typeList, err := s.types.WithTx(tx).List(ctx, true)
	if err != nil {
		return nil, nil, err
	}
	catList, err := s.cats.WithTx(tx).List(ctx, true)
	if err != nil {
		return nil, nil, err
	}
	catalog, err := s.products.WithTx(tx).Catalog(ctx)
	if err != nil {
		return nil, nil, err
	}
	fields, err := s.caps.WithTx(tx).FieldsByKey(ctx)
	if err != nil {
		return nil, nil, err
	}
	var scope catalogScope
	if err := json.Unmarshal(run.CatalogScope, &scope); err != nil {
		return nil, nil, err
	}
	scope.normalize()
	token, err := scopeToken(typeList, catList, catalog, fields, scope)
	if err != nil {
		return nil, nil, err
	}
	if token != run.CatalogToken {
		return nil, nil, errStale()
	}
	return typesByID(typeList), categoriesByID(catList), nil
}

type planned struct {
	seq     int
	entity  string
	status  string
	skipped bool
	item    ImportItem
	plan    planEntry
}

// executor writes a plan's items in order.
type executor struct {
	ctx          context.Context
	tx           pgx.Tx
	s            *Service
	allOrNothing bool
	preview      ImportCounts
	items        []*planned
	// The services on the apply's transaction: all or nothing, without
	// savepoints (the first error ends the apply anyway); otherwise each unit
	// gets a savepoint.
	cats  *categories.Service
	prods *products.Service
	// Product types and categories as read in the transaction, and the
	// categories the run creates (by item seq).
	types      map[uuid.UUID]producttypes.ProductType
	categories map[uuid.UUID]categories.Category
	created    map[int]categories.Category
	// ids of what the run created, by item seq
	products, variants map[int]uuid.UUID
	// productCategory is the category of a product item after the import.
	productCategory map[int]uuid.UUID
	failed          map[int]bool
	// rowSeq is the item of each file row (for issues).
	rowSeq      map[int]int
	changes     []changeRecord
	issues      []ImportIssue
	applied     ImportCounts
	failedRows  []int
	failedField string
}

func newExecutor(ctx context.Context, tx pgx.Tx, s *Service, allOrNothing bool, preview ImportCounts,
	types map[uuid.UUID]producttypes.ProductType, cats map[uuid.UUID]categories.Category,
) *executor {
	ex := &executor{ctx: ctx, tx: tx, s: s, allOrNothing: allOrNothing, preview: preview, types: types, categories: cats,
		created: map[int]categories.Category{}, products: map[int]uuid.UUID{}, variants: map[int]uuid.UUID{},
		productCategory: map[int]uuid.UUID{}, failed: map[int]bool{}, rowSeq: map[int]int{}}
	direct := tx
	if allOrNothing {
		direct = database.Joined(tx)
	}
	ex.cats, ex.prods = s.cats.WithTx(direct), s.products.WithTx(direct)
	return ex
}

type changeRecord struct {
	entity, action, label string
	id                    uuid.UUID
	before, after         any
}

func (ex *executor) load(rows []store.ListPlanRow) error {
	for _, r := range rows {
		p := &planned{seq: int(r.Seq), entity: r.Entity, status: r.Status, skipped: r.Skipped}
		if err := json.Unmarshal(r.Item, &p.item); err != nil {
			return err
		}
		if err := json.Unmarshal(r.Plan, &p.plan); err != nil {
			return err
		}
		ex.items = append(ex.items, p)
		for _, row := range p.item.Rows {
			if _, ok := ex.rowSeq[row]; !ok || p.entity == "variant" {
				ex.rowSeq[row] = p.seq
			}
		}
	}
	return nil
}

func (ex *executor) run() error {
	ex.applied = ImportCounts{Rows: ex.preview.Rows, RowsSkipped: ex.preview.RowsSkipped, Errors: ex.preview.Errors,
		Warnings: ex.preview.Warnings, Unmapped: ex.preview.Unmapped,
		Addons: ImportAddonCounter{Unresolved: ex.preview.Addons.Unresolved}, Images: ImportImageCounter{Files: ex.preview.Images.Files}}
	// Units: a category, or a product with its variants (they follow
	// it in seq order and point to it with ProductSeq).
	for i := 0; i < len(ex.items); {
		unit := []*planned{ex.items[i]}
		for i++; i < len(ex.items) && ex.items[i].entity == "variant" && ex.items[i].plan.ProductSeq == unit[0].seq; i++ {
			unit = append(unit, ex.items[i])
		}
		if err := ex.unit(unit); err != nil {
			return err
		}
	}
	return ex.addons()
}

// unit writes one unit. Without all or nothing a unit that writes gets a
// savepoint, and a failing one is rolled back and reported at all its rows;
// a unit without writes (everything unchanged) needs none.
func (ex *executor) unit(unit []*planned) error {
	var (
		changes []changeRecord
		applied ImportCounts
		ids     = map[int]uuid.UUID{}
	)
	writes := false
	for _, it := range unit {
		writes = writes || (it.status != "unchanged" && !it.skipped)
	}
	write := func(cats *categories.Service, prods *products.Service) error {
		var batch []*planned // new variants, all or nothing: one statement
		for _, it := range unit {
			if it.skipped || ex.failed[it.plan.CategorySeq] || ex.failed[it.plan.ProductSeq] {
				ex.failed[it.seq] = true // its dependants are skipped too
				continue
			}
			if failTestHook != nil {
				if err := failTestHook(it.item); err != nil {
					ex.failedRows = it.item.Rows
					return err
				}
			}
			if ex.allOrNothing && it.entity == "variant" && it.status == "new" {
				count(&applied.Variants, it.status)
				countImage(&applied, it.plan)
				batch = append(batch, it)
				continue
			}
			change, err := ex.write(cats, prods, it, ids, &applied)
			if err != nil {
				ex.failedRows = it.item.Rows
				return err
			}
			if change != nil {
				changes = append(changes, *change)
			}
		}
		if len(batch) == 0 {
			return nil
		}
		p := batch[0].plan
		productID := ex.productOf(p, ids)
		in := make([]products.VariantInput, len(batch))
		for i, it := range batch {
			in[i] = *it.plan.Variant
		}
		known := ex.variantKnown(p)
		known.NewProduct = p.ProductID == nil // created in this unit
		created, failed, err := prods.CreateVariantRows(ex.ctx, productID, in, known)
		if err != nil {
			if failed >= 0 {
				ex.failedRows = batch[failed].item.Rows
			} else {
				ex.failedRows = batch[0].item.Rows
			}
			return err
		}
		for i, it := range batch {
			ids[it.seq] = created[i].ID
			changes = append(changes, changeRecord{entity: "variant", action: "create", id: created[i].ID,
				label: variantLabel(it.item.ModelNumber, it.item.SKU, it.item.Name), after: created[i]})
		}
		return nil
	}
	var err error
	if ex.allOrNothing || !writes {
		err = write(ex.cats, ex.prods)
	} else {
		err = database.InTx(ex.ctx, database.NewNested(ex.tx), pgx.TxOptions{}, func(sp pgx.Tx) error {
			return write(ex.s.cats.WithTx(sp), ex.s.products.WithTx(sp))
		})
	}
	if err != nil {
		var ae *apperr.Error
		if ex.allOrNothing || !errors.As(err, &ae) || apperr.IsRetryable(err) || staleError(err) {
			return err
		}
		// Skip the unit; report the error at every row of it.
		rows := map[int]bool{}
		for _, it := range unit {
			ex.failed[it.seq] = true
			for _, r := range it.item.Rows {
				rows[r] = true
			}
		}
		code, params := ae.Code, ae.Params
		if len(ae.Fields) > 0 {
			code, params = ae.Fields[0].Code, ae.Fields[0].Params
		}
		for _, row := range slices.Sorted(maps.Keys(rows)) {
			ex.issues = append(ex.issues, ImportIssue{Severity: "error", Row: row, ModelNumber: unit[0].item.ModelNumber, Code: code, Params: params, ItemSeq: ex.rowSeq[row]})
		}
		ex.applied.Errors++
		return nil
	}
	for seq, id := range ids {
		switch kindOf(unit, seq) {
		case "category":
			// ex.created is set by write
		case "product":
			ex.products[seq] = id
		case "variant":
			ex.variants[seq] = id
		}
	}
	ex.changes = append(ex.changes, changes...)
	add(&ex.applied, applied)
	return nil
}

func kindOf(unit []*planned, seq int) string {
	for _, it := range unit {
		if it.seq == seq {
			return it.entity
		}
	}
	return ""
}

func add(to *ImportCounts, c ImportCounts) {
	for _, pair := range [][2]*ImportCounter{{&to.Categories, &c.Categories}, {&to.Products, &c.Products}, {&to.Variants, &c.Variants}} {
		pair[0].New += pair[1].New
		pair[0].Changed += pair[1].Changed
		pair[0].Unchanged += pair[1].Unchanged
		pair[0].Deactivate += pair[1].Deactivate
	}
	to.Images.New += c.Images.New
	to.Images.Changed += c.Images.Changed
	to.Images.Unchanged += c.Images.Unchanged
}

func count(c *ImportCounter, status string) {
	switch status {
	case "new":
		c.New++
	case "changed":
		c.Changed++
	case "unchanged":
		c.Unchanged++
	case "deactivate":
		c.Deactivate++
	}
}

// category returns a category by id, or the one the run created for seq.
func (ex *executor) category(id uuid.UUID, seq int) *categories.Category {
	if seq != 0 {
		if c, ok := ex.created[seq]; ok {
			return &c
		}
		return nil
	}
	if c, ok := ex.categories[id]; ok {
		return &c
	}
	return nil
}

// variantKnown is what a variant write of the plan entry may skip reading:
// its product's category after the import.
func (ex *executor) variantKnown(p planEntry) products.Known {
	var known products.Known
	if id, ok := ex.productCategory[p.ProductSeq]; ok {
		known.Category = ex.category(id, 0)
	}
	return known
}

// write applies one item and returns its change log entry (nil when
// nothing was written). Created ids go to ids by seq. The writes get the
// product type and category the transaction already read (products.Known).
func (ex *executor) write(cats *categories.Service, prods *products.Service, it *planned, ids map[int]uuid.UUID, applied *ImportCounts) (*changeRecord, error) {
	ctx, p := ex.ctx, it.plan
	switch it.entity {
	case "category":
		if it.status == "changed" {
			// Links of an existing category's attributes to catalog fields
			// (D-import links). No change log entry: undo leaves the links
			// (they only add a meaning) and must not delete the category.
			if err := cats.LinkFields(ctx, *p.ID, p.Links); err != nil {
				return nil, err
			}
			applied.Categories.Changed++
			return nil, nil
		}
		c, err := cats.Create(ctx, *p.Category)
		if err != nil {
			return nil, err
		}
		ids[it.seq] = c.ID
		ex.created[it.seq] = c
		applied.Categories.New++
		return &changeRecord{entity: "category", action: "create", id: c.ID, label: c.Key, after: categoryState(c)}, nil

	case "product":
		count(&applied.Products, it.status)
		if p.Product != nil {
			ex.productCategory[it.seq] = p.Product.CategoryID
		}
		switch it.status {
		case "unchanged":
			ids[it.seq] = *p.ID
			return nil, nil
		case "deactivate":
			after, err := prods.SetProductActive(ctx, *p.ID, false, p.ExpectedUpdatedAt)
			if err != nil {
				return nil, err
			}
			return &changeRecord{entity: "product", action: "deactivate", id: after.ID, label: after.ModelNumber, before: p.BeforeProduct, after: after}, nil
		}
		in := *p.Product
		if p.CategorySeq != 0 {
			c, ok := ex.created[p.CategorySeq]
			if !ok {
				return nil, nil
			}
			in.CategoryID = c.ID
			ex.productCategory[it.seq] = c.ID
		}
		known := products.Known{Category: ex.category(in.CategoryID, p.CategorySeq)}
		if t, ok := ex.types[in.ProductTypeID]; ok {
			known.Type = &t
		}
		if it.status == "new" {
			after, err := prods.CreateProductRow(ctx, in, known)
			if err != nil {
				return nil, err
			}
			ids[it.seq] = after.ID
			return &changeRecord{entity: "product", action: "create", id: after.ID, label: after.ModelNumber, after: after}, nil
		}
		ids[it.seq] = *p.ID
		after, err := prods.UpdateProductRow(ctx, *p.ID, products.ProductUpdate{ProductInput: in, ExpectedUpdatedAt: p.ExpectedUpdatedAt}, known)
		if err != nil {
			return nil, err
		}
		return &changeRecord{entity: "product", action: "update", id: after.ID, label: after.ModelNumber, before: p.BeforeProduct, after: after}, nil

	case "variant":
		count(&applied.Variants, it.status)
		productID := ex.productOf(p, ids)
		label := variantLabel(it.item.ModelNumber, it.item.SKU, it.item.Name)
		known := ex.variantKnown(p)
		switch it.status {
		case "unchanged":
			ids[it.seq] = *p.ID
			countImage(applied, p)
			return nil, nil
		case "deactivate":
			after, err := prods.SetVariantActive(ctx, productID, *p.ID, false, p.ExpectedUpdatedAt)
			if err != nil {
				return nil, err
			}
			return &changeRecord{entity: "variant", action: "deactivate", id: after.ID, label: label, before: p.BeforeVariant, after: after}, nil
		case "new":
			after, err := prods.CreateVariantRow(ctx, productID, *p.Variant, known)
			if err != nil {
				return nil, err
			}
			ids[it.seq] = after.ID
			countImage(applied, p)
			return &changeRecord{entity: "variant", action: "create", id: after.ID, label: label, after: after}, nil
		}
		ids[it.seq] = *p.ID
		countImage(applied, p)
		if onlyAddons(it.item.Changes) {
			return nil, nil // the add-on phase writes them
		}
		after, err := prods.UpdateVariantRow(ctx, productID, *p.ID, products.VariantUpdate{VariantInput: *p.Variant, ExpectedUpdatedAt: p.ExpectedUpdatedAt}, known)
		if err != nil {
			return nil, err
		}
		return &changeRecord{entity: "variant", action: "update", id: after.ID, label: label, before: p.BeforeVariant, after: after}, nil
	}
	return nil, fmt.Errorf("imports: unknown item entity %q", it.entity)
}

// countImage counts a written variant's image like the preview does.
func countImage(applied *ImportCounts, p planEntry) {
	if p.Variant == nil || p.Variant.ImageFileID == nil {
		return
	}
	switch before := p.BeforeVariant; {
	case before == nil || before.ImageFileID == nil:
		applied.Images.New++
	case *before.ImageFileID != *p.Variant.ImageFileID:
		applied.Images.Changed++
	default:
		applied.Images.Unchanged++
	}
}

func onlyAddons(changes []ImportFieldChange) bool {
	for _, c := range changes {
		if c.Field != "addons" {
			return false
		}
	}
	return true
}

func (ex *executor) productOf(p planEntry, ids map[int]uuid.UUID) uuid.UUID {
	if p.ProductID != nil {
		return *p.ProductID
	}
	if id, ok := ids[p.ProductSeq]; ok {
		return id
	}
	return ex.products[p.ProductSeq]
}

// addonState is an add-on list in the change log.
type addonState struct {
	ProductID uuid.UUID             `json:"productId"`
	Addons    []products.AddonInput `json:"addons"`
	Refs      []ImportAddonRef      `json:"refs"`
}

// addons replaces the add-on lists that change, once every variant exists.
// Links to variants that were skipped are left out (with a warning). All or
// nothing, the lists are written together in a few statements.
func (ex *executor) addons() error {
	var (
		batch      []products.VariantAddons
		batchItems []*planned
		batchDone  []changeRecord
	)
	for _, it := range ex.items {
		p := it.plan
		if it.entity != "variant" || p.Addons == nil || it.skipped || ex.failed[it.seq] || ex.failed[p.ProductSeq] {
			continue
		}
		variantID, ok := ex.variants[it.seq]
		if p.ID != nil {
			variantID, ok = *p.ID, true
		}
		if !ok {
			continue
		}
		productID := ex.productOf(p, map[int]uuid.UUID{})
		list := []products.AddonInput{}
		refs := []ImportAddonRef{}
		for _, a := range *p.Addons {
			id := a.VariantID
			if id == nil {
				created, ok := ex.variants[a.Seq]
				if !ok {
					// Its unit failed (skipped): the link is left out.
					for _, row := range it.item.Rows {
						ex.issues = append(ex.issues, ImportIssue{Severity: "warning", Row: row, ModelNumber: it.item.ModelNumber, Target: "addon",
							Code: "import.addon_skipped", Params: map[string]any{"ref": a.Label}, ItemSeq: it.seq})
						ex.applied.Warnings++
					}
					ex.applied.Addons.Unresolved++
					continue
				}
				id = &created
			}
			list = append(list, products.AddonInput{AddonVariantID: *id, Required: a.Required})
			refs = append(refs, ImportAddonRef{VariantID: id, Label: a.Label, Required: a.Required})
		}
		var before []products.AddonInput
		if p.BeforeVariant != nil {
			before = p.BeforeVariant.Addons
		}
		var beforeState *addonState
		if p.BeforeVariant != nil {
			beforeRefs := []ImportAddonRef{}
			if f := findChange(it.item.Changes, "addons"); f != nil {
				data, _ := json.Marshal(f.Before)
				_ = json.Unmarshal(data, &beforeRefs)
			}
			beforeState = &addonState{ProductID: productID, Addons: nonNil(before), Refs: beforeRefs}
		}
		change := changeRecord{entity: "addons", action: "update", id: variantID,
			label: variantLabel(it.item.ModelNumber, it.item.SKU, it.item.Name), before: beforeState,
			after: addonState{ProductID: productID, Addons: list, Refs: refs}}
		if ex.allOrNothing {
			if failTestHook != nil {
				if err := failTestHook(ImportItem{Entity: "addons", Rows: it.item.Rows, ModelNumber: it.item.ModelNumber}); err != nil {
					ex.failedRows = it.item.Rows
					return err
				}
			}
			batch = append(batch, products.VariantAddons{ProductID: productID, VariantID: variantID, Addons: list})
			batchItems, batchDone = append(batchItems, it), append(batchDone, change)
			countLinks(&ex.applied.Addons, before, list)
			continue
		}
		setAddons := func(prods *products.Service) error {
			if failTestHook != nil {
				if err := failTestHook(ImportItem{Entity: "addons", Rows: it.item.Rows, ModelNumber: it.item.ModelNumber}); err != nil {
					return err
				}
			}
			return prods.SetAddons(ex.ctx, productID, variantID, list)
		}
		err := database.InTx(ex.ctx, database.NewNested(ex.tx), pgx.TxOptions{}, func(sp pgx.Tx) error {
			return setAddons(ex.s.products.WithTx(sp))
		})
		if err != nil {
			var ae *apperr.Error
			if ex.allOrNothing || !errors.As(err, &ae) || apperr.IsRetryable(err) || staleError(err) {
				ex.failedRows = it.item.Rows
				return err
			}
			for _, row := range it.item.Rows {
				ex.issues = append(ex.issues, ImportIssue{Severity: "error", Row: row, ModelNumber: it.item.ModelNumber, Target: "addon", Code: ae.Code, Params: ae.Params, ItemSeq: it.seq})
			}
			ex.applied.Errors++
			continue
		}
		countLinks(&ex.applied.Addons, before, list)
		ex.changes = append(ex.changes, change)
	}
	if len(batch) == 0 {
		return nil
	}
	if failed, err := ex.prods.SetAddonLists(ex.ctx, batch); err != nil {
		if failed >= 0 {
			ex.failedRows = batchItems[failed].item.Rows
		}
		return err
	}
	ex.changes = append(ex.changes, batchDone...)
	return nil
}

func nonNil(list []products.AddonInput) []products.AddonInput {
	if list == nil {
		return []products.AddonInput{}
	}
	return list
}

func findChange(changes []ImportFieldChange, field string) *ImportFieldChange {
	for i := range changes {
		if changes[i].Field == field {
			return &changes[i]
		}
	}
	return nil
}

// countLinks counts how a variant's add-on list changes.
func countLinks(c *ImportAddonCounter, before, after []products.AddonInput) {
	pos := map[uuid.UUID]int{}
	for i, a := range before {
		pos[a.AddonVariantID] = i
	}
	kept := map[uuid.UUID]bool{}
	for i, a := range after {
		j, ok := pos[a.AddonVariantID]
		switch {
		case !ok:
			c.New++
		case before[j].Required != a.Required || i != j:
			c.Changed++
		default:
			c.Unchanged++
		}
		kept[a.AddonVariantID] = true
	}
	for _, a := range before {
		if !kept[a.AddonVariantID] {
			c.Removed++
		}
	}
}

// categoryStateJSON is a created category in the change log.
type categoryStateJSON struct {
	ID        uuid.UUID `json:"id"`
	Key       string    `json:"key"`
	Name      i18n.Text `json:"name"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func categoryState(c categories.Category) categoryStateJSON {
	return categoryStateJSON{ID: c.ID, Key: c.Key, Name: c.Name, UpdatedAt: c.UpdatedAt}
}

func changeRows(runID uuid.UUID, changes []changeRecord) ([]store.InsertChangesParams, error) {
	out := make([]store.InsertChangesParams, len(changes))
	for i, c := range changes {
		var before []byte
		if c.before != nil && !isNilPointer(c.before) {
			data, err := json.Marshal(c.before)
			if err != nil {
				return nil, err
			}
			before = data
		}
		after, err := json.Marshal(c.after)
		if err != nil {
			return nil, err
		}
		out[i] = store.InsertChangesParams{RunID: runID, Seq: int32(i + 1), Entity: c.entity, Action: c.action, //nolint:gosec // bounded
			EntityID: c.id, Label: c.label, Before: before, After: after}
	}
	return out, nil
}

func isNilPointer(v any) bool {
	switch x := v.(type) {
	case *products.CatalogProduct:
		return x == nil
	case *products.CatalogVariant:
		return x == nil
	case *addonState:
		return x == nil
	}
	return false
}

// ---------------------------------------------------------------- undo

// ImportConflict names an entity that changed since an import touched it.
type ImportConflict struct {
	Entity string    `json:"entity"`
	ID     uuid.UUID `json:"id"`
	Label  string    `json:"label"`
	// ProductID is a variant's (or add-on list's) product, for a link.
	ProductID *uuid.UUID `json:"productId,omitempty"`
}

// Undo reverts an applied run in one transaction, if nothing it touched
// changed since (409 import.undo_conflict otherwise, naming at most
// MaxConflicts entities in params.entities, the total in params.count):
// add-on lists and changed products and variants get their state before
// the import back, deactivated ones are reactivated, created variants,
// products and categories are deleted. Files stay (D58).
func (s *Service) Undo(ctx context.Context, id uuid.UUID) (ImportRun, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportRun{}, err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ApplyTimeout)
	defer cancel()
	var row store.ImportRun
	err := s.inTx(ctx, applyTx, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := q.BumpImportLock(ctx); err != nil {
			return err
		}
		run, err := q.LockRun(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if run.State != StateApplied {
			return errState(run.State)
		}
		rows, err := q.AllChanges(ctx, id)
		if err != nil {
			return err
		}
		// One transaction that gives up at the first error: the services
		// join it without savepoints.
		joined := database.Joined(tx)
		u, err := newUndo(ctx, s.cats.WithTx(joined), s.products.WithTx(joined), rows)
		if err != nil {
			return err
		}
		if conflicts := u.conflicts(); len(conflicts) > 0 {
			return errUndoConflict(conflicts)
		}
		if undoTestHook != nil {
			undoTestHook()
		}
		if err := u.revert(); err != nil {
			return err
		}
		row, err = q.SetRunState(ctx, store.SetRunStateParams{ID: id, State: StateUndone, Counts: run.Counts, AllOrNothing: run.AllOrNothing})
		return err
	})
	if err != nil {
		return ImportRun{}, err
	}
	return runOut(row)
}

func errUndoConflict(conflicts []ImportConflict) error {
	shown := conflicts[:min(len(conflicts), MaxConflicts)]
	return apperr.Conflict("import.undo_conflict", "entities changed since the import").
		With("count", len(conflicts)).With("entities", shown)
}

type undoChange struct {
	store.ImportChange
	product products.CatalogProduct
	variant products.CatalogVariant
	addons  addonState
	catInfo categoryStateJSON
	before  json.RawMessage
}

type undo struct {
	ctx      context.Context
	cats     *categories.Service
	prods    *products.Service
	changes  []*undoChange
	products map[uuid.UUID]*products.CatalogProduct
	variants map[uuid.UUID]*products.CatalogVariant
	catsNow  map[uuid.UUID]categories.Category
	// what the run created and which add-on lists it set
	createdProducts, createdVariants, addonLists map[uuid.UUID]*undoChange
}

func newUndo(ctx context.Context, cats *categories.Service, prods *products.Service, rows []store.ImportChange) (*undo, error) {
	u := &undo{ctx: ctx, cats: cats, prods: prods, products: map[uuid.UUID]*products.CatalogProduct{},
		variants: map[uuid.UUID]*products.CatalogVariant{}, catsNow: map[uuid.UUID]categories.Category{},
		createdProducts: map[uuid.UUID]*undoChange{}, createdVariants: map[uuid.UUID]*undoChange{}, addonLists: map[uuid.UUID]*undoChange{}}
	catalog, err := prods.Catalog(ctx)
	if err != nil {
		return nil, err
	}
	for i := range catalog {
		p := &catalog[i]
		u.products[p.ID] = p
		for j := range p.Variants {
			u.variants[p.Variants[j].ID] = &p.Variants[j]
		}
	}
	list, err := cats.List(ctx, true)
	if err != nil {
		return nil, err
	}
	for _, c := range list {
		u.catsNow[c.ID] = c
	}
	for _, r := range rows {
		c := &undoChange{ImportChange: r, before: r.Before}
		var target any
		switch r.Entity {
		case "category":
			target = &c.catInfo
		case "product":
			target = &c.product
		case "variant":
			target = &c.variant
		case "addons":
			target = &c.addons
		}
		if err := json.Unmarshal(r.After, target); err != nil {
			return nil, err
		}
		switch {
		case r.Entity == "product" && r.Action == "create":
			u.createdProducts[r.EntityID] = c
		case r.Entity == "variant" && r.Action == "create":
			u.createdVariants[r.EntityID] = c
		case r.Entity == "addons":
			u.addonLists[r.EntityID] = c
		}
		u.changes = append(u.changes, c)
	}
	return u, nil
}

// conflicts lists the entities that changed since the import: anything it
// wrote whose content differs now (or is gone; created categories by
// version, and products put in them since), add-on lists that differ,
// created products with variants added since, and links to created
// variants made since (deleting those variants would remove them).
func (u *undo) conflicts() []ImportConflict {
	out := []ImportConflict{}
	seen := map[uuid.UUID]bool{}
	conflict := func(entity string, id uuid.UUID, label string, productID ...uuid.UUID) {
		if !seen[id] {
			seen[id] = true
			c := ImportConflict{Entity: entity, ID: id, Label: label}
			if v, ok := u.variants[id]; ok && entity != "product" && entity != "category" {
				pid := v.ProductID
				c.ProductID = &pid
			} else if len(productID) > 0 && productID[0] != uuid.Nil {
				pid := productID[0]
				c.ProductID = &pid
			}
			out = append(out, c)
		}
	}
	for _, c := range u.changes {
		switch c.Entity {
		case "category":
			k, ok := u.catsNow[c.EntityID]
			if !ok || !k.UpdatedAt.Equal(c.catInfo.UpdatedAt) {
				conflict("category", c.EntityID, c.Label)
				continue
			}
			for _, p := range u.products {
				if p.CategoryID == c.EntityID && !u.leavesCategory(p.ID, c.EntityID) {
					conflict("product", p.ID, p.ModelNumber)
				}
			}
		case "product":
			p, ok := u.products[c.EntityID]
			if !ok || !sameProduct(*p, c.product) {
				conflict("product", c.EntityID, c.Label)
				continue
			}
			if c.Action == "create" {
				for _, v := range p.Variants {
					if u.createdVariants[v.ID] == nil {
						conflict("variant", v.ID, variantLabel(p.ModelNumber, v.SKU, v.Name))
					}
				}
			}
		case "variant":
			v, ok := u.variants[c.EntityID]
			if !ok || !sameVariant(*v, c.variant) {
				conflict("variant", c.EntityID, c.Label, c.variant.ProductID)
			}
		case "addons":
			v, ok := u.variants[c.EntityID]
			if !ok || !sameJSON(nonNil(v.Addons), nonNil(c.addons.Addons)) {
				conflict("addons", c.EntityID, c.Label, c.addons.ProductID)
				continue
			}
			var before addonState
			if c.before != nil && json.Unmarshal(c.before, &before) == nil {
				for _, a := range before.Addons {
					if _, ok := u.variants[a.AddonVariantID]; !ok {
						conflict("addons", c.EntityID, c.Label)
					}
				}
			}
		}
	}
	// A model number or SKU that undo restores and that another product or
	// variant, which the run did not touch, has taken since.
	touched := map[uuid.UUID]bool{}
	for _, c := range u.changes {
		touched[c.EntityID] = true
	}
	models, skus := map[string]*products.CatalogProduct{}, map[string]*products.CatalogVariant{}
	for _, p := range u.products {
		models[products.MatchKey(p.ModelNumber)] = p
	}
	for _, v := range u.variants {
		if v.SKU != "" {
			skus[products.MatchKey(v.SKU)] = v
		}
	}
	for _, c := range u.changes {
		if c.before == nil || (c.Entity != "product" && c.Entity != "variant") {
			continue
		}
		if c.Entity == "product" {
			var before products.CatalogProduct
			if json.Unmarshal(c.before, &before) == nil {
				if owner := models[products.MatchKey(before.ModelNumber)]; owner != nil && owner.ID != c.EntityID && !touched[owner.ID] {
					conflict("product", owner.ID, owner.ModelNumber)
				}
			}
			continue
		}
		var before products.CatalogVariant
		if json.Unmarshal(c.before, &before) == nil && before.SKU != "" {
			if owner := skus[products.MatchKey(before.SKU)]; owner != nil && owner.ID != c.EntityID && !touched[owner.ID] {
				p := u.products[owner.ProductID]
				conflict("variant", owner.ID, variantLabel(p.ModelNumber, owner.SKU, owner.Name))
			}
		}
	}
	for _, p := range u.products {
		for _, v := range p.Variants {
			if u.createdVariants[v.ID] != nil || u.addonLists[v.ID] != nil {
				continue
			}
			for _, a := range v.Addons {
				if u.createdVariants[a.AddonVariantID] != nil {
					conflict("addons", v.ID, variantLabel(p.ModelNumber, v.SKU, v.Name))
				}
			}
		}
	}
	return out
}

// sameProduct compares a product's own fields (not its version: a later
// run that was undone, or a save without changes, moves the version only).
func sameProduct(a, b products.CatalogProduct) bool {
	a.UpdatedAt, b.UpdatedAt, a.Variants, b.Variants = time.Time{}, time.Time{}, nil, nil
	return sameJSON(a, b)
}

func sameVariant(a, b products.CatalogVariant) bool {
	a.UpdatedAt, b.UpdatedAt, a.Addons, b.Addons, a.SortOrder, b.SortOrder = time.Time{}, time.Time{}, nil, nil, 0, 0
	a.AddonsUpdatedAt, b.AddonsUpdatedAt = time.Time{}, time.Time{}
	return sameJSON(a, b)
}

// leavesCategory reports whether undoing removes product id from the
// category: the run created it, or changed its category and restores
// another one.
func (u *undo) leavesCategory(productID, categoryID uuid.UUID) bool {
	if u.createdProducts[productID] != nil {
		return true
	}
	for _, c := range u.changes {
		if c.Entity == "product" && c.EntityID == productID && c.before != nil {
			var before products.CatalogProduct
			if json.Unmarshal(c.before, &before) == nil && before.CategoryID != categoryID {
				return true
			}
		}
	}
	return false
}

// revert undoes the changes in reverse order.
func (u *undo) revert() error {
	ctx := u.ctx
	for i := len(u.changes) - 1; i >= 0; i-- {
		c := u.changes[i]
		var err error
		switch {
		case c.Entity == "addons":
			before := []products.AddonInput{}
			if c.before != nil {
				var state addonState
				if err := json.Unmarshal(c.before, &state); err != nil {
					return err
				}
				before = nonNil(state.Addons)
			}
			err = u.prods.SetAddons(ctx, c.addons.ProductID, c.EntityID, before)
		case c.Entity == "variant" && c.Action == "create":
			err = u.prods.DeleteVariant(ctx, c.variant.ProductID, c.EntityID)
		case c.Entity == "variant":
			var before products.CatalogVariant
			if err := json.Unmarshal(c.before, &before); err != nil {
				return err
			}
			_, err = u.prods.RestoreVariant(ctx, before, u.variants[c.EntityID].UpdatedAt)
		case c.Entity == "product" && c.Action == "create":
			err = u.prods.Delete(ctx, c.EntityID)
		case c.Entity == "product":
			var before products.CatalogProduct
			if err := json.Unmarshal(c.before, &before); err != nil {
				return err
			}
			_, err = u.prods.RestoreProduct(ctx, before, u.products[c.EntityID].UpdatedAt)
		case c.Entity == "category":
			err = u.cats.Delete(ctx, c.EntityID)
		}
		if err != nil {
			var ae *apperr.Error
			if errors.As(err, &ae) && !apperr.IsRetryable(err) && (strings.HasSuffix(ae.Code, "_taken") || strings.HasSuffix(ae.Code, ".stale")) {
				// Something it restores is in use again (checked above as far
				// as the catalog shows it): the entity is in conflict.
				entity := c.Entity
				return errUndoConflict([]ImportConflict{{Entity: entity, ID: c.EntityID, Label: c.Label}})
			}
			return err
		}
	}
	return nil
}
