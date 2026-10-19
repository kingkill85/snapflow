package bom

import (
	"context"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// used returns the variant ids of the snapshots the BOM shows (used by a
// placement or a manual line, directly or as add-on).
func (st *state) used() []uuid.UUID {
	accs, _ := st.counts()
	out := make([]uuid.UUID, 0, len(accs))
	for id := range accs {
		out = append(out, id)
	}
	ord := st.order()
	slices.SortFunc(out, func(a, b uuid.UUID) int { return ord.less(st.items[a], st.items[b]) })
	return out
}

// resnapshot is the snapshot item would have after "Update from catalog".
func resnapshot(it store.VersionItem, f products.BOMVariant) store.VersionItem {
	p := insertParams(projectsRef(it), f)
	it.ProductID, it.ProductName, it.VariantName, it.ModelNumber, it.Sku = p.ProductID, p.ProductName, p.VariantName, p.ModelNumber, p.Sku
	it.ProductTypeID, it.ProductTypeKey, it.ProductTypeName = p.ProductTypeID, p.ProductTypeKey, p.ProductTypeName
	it.ProductTypeAbbreviation, it.ProductTypeColor, it.ProductTypePosition = p.ProductTypeAbbreviation, p.ProductTypeColor, p.ProductTypePosition
	it.CategoryID, it.CategoryName, it.CategoryPosition = p.CategoryID, p.CategoryName, p.CategoryPosition
	it.UnitPrice, it.ImageFileID, it.RequiredAddonIds = p.UnitPrice, p.ImageFileID, p.RequiredAddonIds
	return it
}

func (st *state) values(it store.VersionItem) ChangeValues {
	v := ChangeValues{
		UnitPrice: money.USD(money.MustParse(it.UnitPrice)), ProductName: it.ProductName, VariantName: it.VariantName,
		ModelNumber: it.ModelNumber, SKU: deref(it.Sku), ImageURL: imageURL(it.ImageFileID), RequiredAddons: []RequiredAddon{},
	}
	for _, id := range it.RequiredAddonIds {
		r := RequiredAddon{VariantID: id}
		if a, ok := st.items[id]; ok {
			r.ModelNumber, r.VariantName = a.ModelNumber, a.VariantName
		} else if f, ok := st.catalog[id]; ok {
			r.ModelNumber, r.VariantName = f.ModelNumber, f.VariantName
		}
		v.RequiredAddons = append(v.RequiredAddons, r)
	}
	return v
}

// CatalogChanges lists the used snapshots that differ from the catalog
// (or whose variant was deleted), field by field, with the effect of
// updating each on the grand total.
func (s *Service) CatalogChanges(ctx context.Context, versionID uuid.UUID) (CatalogChanges, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return CatalogChanges{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return CatalogChanges{}, err
	}
	// Required add-ons named by the catalog that have no snapshot yet.
	var extra []uuid.UUID
	for _, f := range st.catalog {
		for _, r := range f.RequiredAddonIDs {
			if _, ok := st.items[r]; !ok {
				extra = append(extra, r)
			}
		}
	}
	if len(extra) > 0 {
		more, err := s.products.BOMVariants(ctx, extra)
		if err != nil {
			return CatalogChanges{}, err
		}
		for id, f := range more {
			if _, ok := st.catalog[id]; !ok {
				st.catalog[id] = f
			}
		}
	}

	now := st.grandTotal()
	out := CatalogChanges{Items: []CatalogChange{}, GrandTotal: money.USD(now)}
	after := st.clone()
	for _, id := range st.used() {
		it := st.items[id]
		f, exists := st.catalog[id]
		c := CatalogChange{VariantID: id, ProductID: it.ProductID, Snapshot: snapshotOf(it), Before: st.values(it), Effect: "0.00"}
		if !exists {
			c.Deleted, c.Fields = true, []string{}
			out.Items = append(out.Items, c)
			continue
		}
		c.Fields = changedFields(it, f)
		if len(c.Fields) == 0 {
			continue
		}
		c.Available, c.CanApply = f.Available, true
		next := resnapshot(it, f)
		v := st.values(next)
		c.After = &NullableChangeValues{ChangeValues: v}
		one := st.clone()
		one.apply(id, next)
		c.Effect = money.USD(one.grandTotal().Sub(now))
		after.apply(id, next)
		out.Items = append(out.Items, c)
	}
	total := after.grandTotal()
	out.GrandTotalAfter, out.Effect = money.USD(total), money.USD(total.Sub(now))
	return out, nil
}

// clone copies the snapshots so a preview can change them.
func (st *state) clone() *state {
	c := *st
	c.items = make(map[uuid.UUID]store.VersionItem, len(st.items))
	for k, v := range st.items {
		c.items[k] = v
	}
	return &c
}

// apply puts a re-snapshot into the preview, with snapshots of new required
// add-ons as the catalog has them.
func (st *state) apply(id uuid.UUID, next store.VersionItem) {
	st.items[id] = next
	for _, r := range next.RequiredAddonIds {
		if _, ok := st.items[r]; ok {
			continue
		}
		if f, ok := st.catalog[r]; ok {
			st.items[r] = resnapshot(store.VersionItem{VersionID: next.VersionID, VariantID: r}, f)
		}
	}
}

// ApplyCatalogChanges re-snapshots the selected used snapshots (or all with
// in.All) from the catalog. Deleted variants and unchanged snapshots are
// skipped (deleted ones stay frozen).
func (s *Service) ApplyCatalogChanges(ctx context.Context, versionID uuid.UUID, in ApplyInput) (ApplyResult, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ApplyResult{}, err
	}
	if !in.All && len(in.VariantIDs) == 0 {
		return ApplyResult{}, apperr.Invalid("body.variantIds", "bom.nothing_selected", "select variants or all")
	}
	// The catalog facts are read before the transaction (D243): the
	// selected variants (every snapshot of the version with all) and the
	// required add-ons they bring that have no snapshot yet.
	ids := in.VariantIDs
	if in.All {
		err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(_ pgx.Tx, q *store.Queries) error {
			ids, err = q.ItemVariantIDs(ctx, versionID)
			return err
		})
		if err != nil {
			return ApplyResult{}, err
		}
	}
	facts, err := s.products.BOMVariants(ctx, ids)
	if err != nil {
		return ApplyResult{}, err
	}
	var required []uuid.UUID
	for _, f := range facts {
		required = append(required, f.RequiredAddonIDs...)
	}
	newAddons, err := s.snapshotFacts(ctx, versionID, required)
	if err != nil {
		return ApplyResult{}, err
	}

	out := ApplyResult{Updated: []uuid.UUID{}, Skipped: []uuid.UUID{}}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		out = ApplyResult{Updated: []uuid.UUID{}, Skipped: []uuid.UUID{}}
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		st := state{ref: ref}
		if err := st.read(ctx, s, tx, q); err != nil {
			return err
		}
		used := st.used()
		selected := in.VariantIDs
		if in.All {
			selected = used
		}
		take := map[uuid.UUID]products.BOMVariant{}
		for _, id := range selected {
			f, ok := facts[id]
			it, has := st.items[id]
			if !ok || !has || !slices.Contains(used, id) || len(changedFields(it, f)) == 0 {
				out.Skipped = append(out.Skipped, id)
				continue
			}
			p := insertParams(ref, f)
			if _, err := q.UpdateItem(ctx, updateParams(p)); err != nil {
				return err
			}
			out.Updated = append(out.Updated, id)
			for _, a := range f.RequiredAddonIDs {
				if af, ok := newAddons[a]; ok {
					take[a] = af
				}
			}
		}
		// New required add-ons get their first snapshot.
		return insertSnapshots(ctx, q, ref, take)
	})
	return out, err
}

func projectsRef(it store.VersionItem) projects.VersionRef {
	return projects.VersionRef{ID: it.VersionID, TenantID: it.TenantID}
}

func updateParams(p store.InsertItemParams) store.UpdateItemParams {
	return store.UpdateItemParams{
		ProductID: p.ProductID, ProductName: p.ProductName, VariantName: p.VariantName, ModelNumber: p.ModelNumber,
		Sku: p.Sku, ProductTypeID: p.ProductTypeID, ProductTypeKey: p.ProductTypeKey, ProductTypeName: p.ProductTypeName,
		ProductTypeAbbreviation: p.ProductTypeAbbreviation, ProductTypeColor: p.ProductTypeColor,
		ProductTypePosition: p.ProductTypePosition, CategoryID: p.CategoryID, CategoryName: p.CategoryName,
		CategoryPosition: p.CategoryPosition, UnitPrice: p.UnitPrice, ImageFileID: p.ImageFileID,
		RequiredAddonIds: p.RequiredAddonIds, VersionID: p.VersionID, VariantID: p.VariantID,
	}
}
