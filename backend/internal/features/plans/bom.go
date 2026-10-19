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

// ContentHook runs in the transaction that saves a plan's content (scoped
// to the caller), after the content is written, with the catalog variants
// the content uses (placement variants and chosen add-ons, sorted, without
// duplicates). A failure fails the save.
type ContentHook func(ctx context.Context, tx pgx.Tx, version projects.VersionRef, variantIDs []uuid.UUID) error

// OnContentSave registers a hook; call it while wiring the features.
func (s *Service) OnContentSave(h ContentHook) { s.contentHooks = append(s.contentHooks, h) }

func (s *Service) runContentHooks(ctx context.Context, tx pgx.Tx, ref projects.VersionRef, placements []PlanPlacement) error {
	if len(s.contentHooks) == 0 {
		return nil
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
	for _, h := range s.contentHooks {
		if err := h(ctx, tx, ref, ids); err != nil {
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
