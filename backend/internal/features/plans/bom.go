package plans

// What the BOM feature (step 2c) uses of plans: the placements of a version
// (read in the caller's transaction) and a hook that runs when a plan's
// content is saved, so the BOM can snapshot newly used variants. Plans never
// read the BOM's tables, the BOM never reads the plan tables (D197).

import (
	"context"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// ContentHook runs when a plan's content is saved, with the catalog variants
// the content uses (placement variants and chosen add-ons, sorted, without
// duplicates). Prepare runs before the save's transaction (no connection or
// row lock held, so it may read through other services and the pool);
// Apply runs in the transaction that saves the content (scoped to the
// caller), after the content is written, with what Prepare returned, and
// must only use tx: a second pooled connection taken while the transaction
// holds one can starve the pool (D243). A failure of either fails the save.
type ContentHook struct {
	Prepare func(ctx context.Context, versionID uuid.UUID, variantIDs []uuid.UUID) (any, error)
	Apply   func(ctx context.Context, tx pgx.Tx, version projects.VersionRef, prepared any) error
}

// OnContentSave registers a hook; call it while wiring the features.
func (s *Service) OnContentSave(h ContentHook) { s.contentHooks = append(s.contentHooks, h) }

// prepareContentHooks runs the hooks' Prepare outside any transaction.
func (s *Service) prepareContentHooks(ctx context.Context, versionID uuid.UUID, placements []PlanPlacement) ([]any, error) {
	if len(s.contentHooks) == 0 {
		return nil, nil
	}
	var ids []uuid.UUID
	for _, p := range placements {
		if p.VariantID != nil {
			ids = append(ids, *p.VariantID)
		}
		ids = append(ids, p.AddonVariantIDs...)
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	ids = slices.Compact(ids)
	out := make([]any, len(s.contentHooks))
	for i, h := range s.contentHooks {
		v, err := h.Prepare(ctx, versionID, ids)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func (s *Service) runContentHooks(ctx context.Context, tx pgx.Tx, ref projects.VersionRef, prepared []any) error {
	for i, h := range s.contentHooks {
		if err := h.Apply(ctx, tx, ref, prepared[i]); err != nil {
			return err
		}
	}
	return nil
}

// BOMPlan is a plan of a version as the BOM sees it.
type BOMPlan struct {
	ID         uuid.UUID
	Name       string
	Zones      []BOMZone
	Placements []BOMPlacement
}

// BOMZone is a zone of a plan.
type BOMZone struct {
	ID   uuid.UUID
	Name string
}

// BOMPlacement is a placement as the BOM counts it.
type BOMPlacement struct {
	ID uuid.UUID
	// VariantID is the catalog variant as last saved, also after the
	// variant was deleted (VariantDeleted); nil only for placements whose
	// variant was deleted before step 2c.
	VariantID       *uuid.UUID
	VariantDeleted  bool
	Existing        bool
	AddonVariantIDs []uuid.UUID
	ZoneID          *uuid.UUID
}

// BOMPlacements returns the plans of a version in their order with their
// zones and placements, read in tx (a transaction scoped to the caller in
// which the version was checked with projects.Service.ReadVersion or
// WriteVersion). Needs projects.read.
func (s *Service) BOMPlacements(ctx context.Context, tx pgx.Tx, versionID uuid.UUID) ([]BOMPlan, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return nil, err
	}
	q := s.q.WithTx(tx)
	plans, err := q.BOMPlans(ctx, versionID)
	if err != nil {
		return nil, err
	}
	zones, err := q.BOMZones(ctx, versionID)
	if err != nil {
		return nil, err
	}
	placements, err := q.BOMPlacements(ctx, versionID)
	if err != nil {
		return nil, err
	}
	out := make([]BOMPlan, len(plans))
	index := make(map[uuid.UUID]int, len(plans))
	for i, p := range plans {
		out[i] = BOMPlan{ID: p.ID, Name: p.Name}
		index[p.ID] = i
	}
	for _, z := range zones {
		if i, ok := index[z.PlanID]; ok {
			out[i].Zones = append(out[i].Zones, BOMZone{ID: z.ID, Name: z.Name})
		}
	}
	for _, p := range placements {
		if i, ok := index[p.PlanID]; ok {
			out[i].Placements = append(out[i].Placements, BOMPlacement{
				ID: p.ID, VariantID: p.CatalogVariantID, VariantDeleted: p.VariantDeleted, Existing: p.Existing,
				AddonVariantIDs: p.AddonVariantIds, ZoneID: p.ZoneID,
			})
		}
	}
	return out, nil
}
