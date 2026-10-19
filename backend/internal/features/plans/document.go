package plans

// What documents (proposals, step 2d) use of plans: every plan of a version
// with its image and content, read in one snapshot; the image contents are
// opened after the transaction ended (D243).

import (
	"context"
	"io"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// maxImageBytes bounds a plan image read for a document (FloorplanImage
// stores re-encoded images well below it).
const maxImageBytes = 64 << 20

// DocumentPlan is a plan with its content and image bytes.
type DocumentPlan struct {
	ID          uuid.UUID
	Name        string
	Width       int32
	Height      int32
	Image       []byte // the stored image file (PNG or JPEG)
	ContentType string
	Zones       []PlanZone
	Placements  []PlanPlacement
}

// DocumentPlans returns the floorplans of a version in their order with
// their content and image (boards come with the board report, 3e). Needs
// projects.read.
func (s *Service) DocumentPlans(ctx context.Context, versionID uuid.UUID) ([]DocumentPlan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var (
		out     []DocumentPlan
		fileIDs []uuid.UUID
	)
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err := q.ListPlans(ctx, versionID)
		if err != nil {
			return err
		}
		for _, r := range rows {
			if r.Kind != KindFloorplan || r.ImageFileID == nil {
				continue
			}
			zones, placements, err := readContent(ctx, q, r.ID)
			if err != nil {
				return err
			}
			out = append(out, DocumentPlan{ID: r.ID, Name: r.Name, Width: *r.ImageWidth, Height: *r.ImageHeight, Zones: zones, Placements: placements})
			fileIDs = append(fileIDs, *r.ImageFileID)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for i, id := range fileIDs {
		f, contents, err := s.files.OpenReferenced(ctx, id)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(contents, maxImageBytes))
		_ = contents.Close()
		if err != nil {
			return nil, err
		}
		out[i].Image, out[i].ContentType = data, f.ContentType
	}
	return out, nil
}
