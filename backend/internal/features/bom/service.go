// Package bom computes the bill of materials of a project version (step 2c)
// from the placements of its plans and its manual lines, keeps the price
// snapshots of the catalog variants a version uses, and holds the version's
// pricing (discount, services). Every money rule is in platform/money.
//
// The tables are tenant-owned (row-level security, database.InScope).
// Versions are checked through projects.Service, placements are read
// through plans.Service, catalog facts through products.Service; this
// feature never reads their tables (CLAUDE.md rule 3, D197).
package bom

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/bom/store"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db       DB
	q        *store.Queries
	projects *projects.Service
	plans    *plans.Service
	products *products.Service
}

// NewService wires the BOM: it registers the version copier with projects
// and the content hook with plans.
func NewService(db DB, projectSvc *projects.Service, planSvc *plans.Service, productSvc *products.Service) *Service {
	s := &Service{db: db, q: store.New(db), projects: projectSvc, plans: planSvc, products: productSvc}
	projectSvc.OnCopyVersion(s.CopyVersion)
	planSvc.OnContentSave(s.snapshotHook)
	return s
}

func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- snapshots

// snapshotHook takes the snapshots of variants a saved plan content uses for
// the first time (plans.Service.OnContentSave).
func (s *Service) snapshotHook(ctx context.Context, tx pgx.Tx, ref projects.VersionRef, ids []uuid.UUID) error {
	return s.ensureSnapshots(ctx, s.q.WithTx(tx), ref, ids)
}

// ensureSnapshots takes a snapshot of every variant of ids (and of its
// required add-ons) that the version has none of. Existing snapshots are
// never changed; a concurrent first appearance keeps the first one
// (ON CONFLICT DO NOTHING). Variants missing from the catalog are skipped.
func (s *Service) ensureSnapshots(ctx context.Context, q *store.Queries, ref projects.VersionRef, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	existing, err := q.ItemVariantIDs(ctx, ref.ID)
	if err != nil {
		return err
	}
	have := make(map[uuid.UUID]bool, len(existing))
	for _, id := range existing {
		have[id] = true
	}
	missing := func(ids []uuid.UUID, also map[uuid.UUID]products.BOMVariant) []uuid.UUID {
		var out []uuid.UUID
		for _, id := range ids {
			if _, ok := also[id]; !have[id] && !ok && !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
		return out
	}
	want := missing(ids, nil)
	if len(want) == 0 {
		return nil
	}
	facts, err := s.products.BOMVariants(ctx, want)
	if err != nil {
		return err
	}
	var addons []uuid.UUID
	for _, f := range facts {
		addons = append(addons, f.RequiredAddonIDs...)
	}
	if more := missing(addons, facts); len(more) > 0 {
		extra, err := s.products.BOMVariants(ctx, more)
		if err != nil {
			return err
		}
		for id, f := range extra {
			facts[id] = f
		}
	}
	keys := make([]uuid.UUID, 0, len(facts))
	for id := range facts {
		keys = append(keys, id)
	}
	// A fixed order keeps concurrent inserts from deadlocking.
	slices.SortFunc(keys, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for _, id := range keys {
		if err := q.InsertItem(ctx, insertParams(ref, facts[id])); err != nil {
			return err
		}
	}
	return nil
}

func insertParams(ref projects.VersionRef, f products.BOMVariant) store.InsertItemParams {
	color := ""
	if f.ProductType.Color != "" {
		color = f.ProductType.Color
	}
	return store.InsertItemParams{
		TenantID: ref.TenantID, VersionID: ref.ID, VariantID: f.ID, ProductID: f.ProductID,
		ProductName: f.ProductName, VariantName: f.VariantName, ModelNumber: f.ModelNumber, Sku: f.SKU,
		ProductTypeID: f.ProductType.ID, ProductTypeKey: f.ProductType.Key, ProductTypeName: f.ProductType.Name,
		ProductTypeAbbreviation: f.ProductType.Abbreviation, ProductTypeColor: color,
		ProductTypePosition: f.ProductType.SortOrder, CategoryID: f.Category.ID, CategoryName: f.Category.Name,
		CategoryPosition: f.Category.SortOrder, UnitPrice: f.Price, ImageFileID: f.ImageFileID,
		RequiredAddonIds: f.RequiredAddonIDs,
	}
}

// CopyVersion copies the snapshots, manual lines and pricing of source into
// target (projects.Service.OnCopyVersion).
func (s *Service) CopyVersion(ctx context.Context, tx pgx.Tx, source, target projects.VersionRef) error {
	if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
		return err
	}
	q := s.q.WithTx(tx)
	if err := q.CopyItems(ctx, store.CopyItemsParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID}); err != nil {
		return err
	}
	if err := q.CopyManualLines(ctx, store.CopyManualLinesParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID}); err != nil {
		return err
	}
	return q.CopyPricing(ctx, store.CopyPricingParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID})
}

// ---------------------------------------------------------------- reading

// state is everything the BOM of a version is computed from, read in one
// snapshot.
type state struct {
	ref     projects.VersionRef
	plans   []plans.BOMPlan
	items   map[uuid.UUID]store.VersionItem
	manual  []store.VersionManualLine
	pricing *store.VersionPricing
	// catalog are the live catalog facts of the snapshots' variants
	// (deleted ones missing).
	catalog map[uuid.UUID]products.BOMVariant
}

func (s *Service) load(ctx context.Context, actor auth.Actor, versionID uuid.UUID) (state, error) {
	var st state
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if st.ref, err = s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		return st.read(ctx, s, tx, q)
	})
	if err != nil {
		return st, err
	}
	ids := make([]uuid.UUID, 0, len(st.items))
	for id := range st.items {
		ids = append(ids, id)
	}
	st.catalog, err = s.products.BOMVariants(ctx, ids)
	return st, err
}

func (st *state) read(ctx context.Context, s *Service, tx pgx.Tx, q *store.Queries) error {
	var err error
	if st.plans, err = s.plans.BOMPlacements(ctx, tx, st.ref.ID); err != nil {
		return err
	}
	rows, err := q.ListItems(ctx, st.ref.ID)
	if err != nil {
		return err
	}
	st.items = make(map[uuid.UUID]store.VersionItem, len(rows))
	for _, r := range rows {
		st.items[r.VariantID] = r
	}
	if st.manual, err = q.ListManualLines(ctx, st.ref.ID); err != nil {
		return err
	}
	p, err := q.GetPricing(ctx, st.ref.ID)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		st.pricing = nil
	case err != nil:
		return err
	default:
		st.pricing = &p
	}
	return nil
}

// Get returns the BOM of a version.
func (s *Service) Get(ctx context.Context, versionID uuid.UUID) (BOM, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return BOM{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return BOM{}, err
	}
	return st.bom(), nil
}

// ---------------------------------------------------------------- helpers

func imageURL(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	u := "/api/files/" + id.String()
	return &u
}

func snapshotOf(it store.VersionItem) ItemSnapshot {
	sku := ""
	if it.Sku != nil {
		sku = *it.Sku
	}
	return ItemSnapshot{
		ProductName: it.ProductName, VariantName: it.VariantName, ModelNumber: it.ModelNumber, SKU: sku,
		ProductType: SnapshotProductType{
			ID: it.ProductTypeID, Key: it.ProductTypeKey, Name: it.ProductTypeName,
			Abbreviation: it.ProductTypeAbbreviation, Color: it.ProductTypeColor,
		},
		Category: SnapshotCategory{ID: it.CategoryID, Name: it.CategoryName},
		ImageURL: imageURL(it.ImageFileID),
	}
}

func price(s string) money.Amount {
	d, err := money.Parse(s)
	if err != nil {
		return money.Zero
	}
	return d
}

func sameText(a, b i18n.Text) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func sameIDs(a, b []uuid.UUID) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[uuid.UUID]int, len(a))
	for _, id := range a {
		set[id]++
	}
	for _, id := range b {
		if set[id] == 0 {
			return false
		}
		set[id]--
	}
	return true
}
