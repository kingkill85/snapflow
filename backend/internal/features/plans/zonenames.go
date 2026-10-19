package plans

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// ZoneName is a zone of a version's floorplans with its short name.
type ZoneName struct {
	PlanID    uuid.UUID
	ID        uuid.UUID
	Name      string
	ShortName string
}

// ZoneNames returns every zone of a version's floorplans in plan and zone
// order with its short name (channel labels, 3e). Needs projects.read.
func (s *Service) ZoneNames(ctx context.Context, versionID uuid.UUID) ([]ZoneName, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var out []ZoneName
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err := q.ZoneNames(ctx, versionID)
		if err != nil {
			return err
		}
		for _, r := range rows {
			out = append(out, ZoneName{PlanID: r.PlanID, ID: r.ID, Name: r.Name, ShortName: r.ShortName})
		}
		return nil
	})
	return out, err
}
