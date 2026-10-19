package plans

// What the wiring feature (step 3d: connections, checks, auto-connect) reads
// of a version's plans: plans in order, zones, needs, placements, board rows
// and modules, in one read.

import (
	"context"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// WiringData is the content of a version's plans that connections refer to.
type WiringData struct {
	Plans []WiringPlan
}

// WiringPlan is a plan with its content, in plan order.
type WiringPlan struct {
	ID       uuid.UUID
	Name     string
	Kind     string
	Position int32
	// Zones, Needs and Placements of a floorplan, in their order.
	Zones      []WiringZone
	Needs      []WiringNeed
	Placements []WiringItem
	// Rows and Modules of a board; modules in row and offset order.
	Rows    []WiringRow
	Modules []WiringItem
}

// WiringZone is a zone of a floorplan.
type WiringZone struct {
	ID   uuid.UUID
	Name string
}

// WiringNeed is a need of a floorplan.
type WiringNeed struct {
	ID             uuid.UUID
	ZoneID         *uuid.UUID
	FunctionTypeID uuid.UUID
	Quantity       int32
	// PowerW per unit, a decimal string with 2 places; nil unknown.
	PowerW     *string
	LoadTypeID *uuid.UUID
	Label      string
}

// WiringRow is a row of DIN rail of a board.
type WiringRow struct {
	ID         uuid.UUID
	Position   int32
	CapacityTE float64
}

// WiringItem is a placement (floorplan, with its zone) or a module (board,
// with its row and offset).
type WiringItem struct {
	ID        uuid.UUID
	VariantID *uuid.UUID
	Label     string
	ZoneID    *uuid.UUID
	RowID     uuid.UUID
	OffsetTE  float64
}

// WiringData reads the plans of a version with their content in tx (scoped
// to the caller; the version checked with projects.Service.ReadVersion or
// WriteVersion). Needs projects.read.
func (s *Service) WiringData(ctx context.Context, tx pgx.Tx, versionID uuid.UUID) (WiringData, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return WiringData{}, err
	}
	q := s.q.WithTx(tx)
	plans, err := q.WiringPlans(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	zones, err := q.WiringZones(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	needs, err := q.VersionNeeds(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	placements, err := q.WiringPlacements(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	rows, err := q.WiringRows(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	modules, err := q.WiringModules(ctx, versionID)
	if err != nil {
		return WiringData{}, err
	}
	out := WiringData{Plans: make([]WiringPlan, len(plans))}
	index := make(map[uuid.UUID]int, len(plans))
	for i, p := range plans {
		out.Plans[i] = WiringPlan{ID: p.ID, Name: p.Name, Kind: p.Kind, Position: p.Position}
		index[p.ID] = i
	}
	for _, z := range zones {
		if i, ok := index[z.PlanID]; ok {
			out.Plans[i].Zones = append(out.Plans[i].Zones, WiringZone{ID: z.ID, Name: z.Name})
		}
	}
	for _, n := range needs {
		if i, ok := index[n.PlanID]; ok {
			out.Plans[i].Needs = append(out.Plans[i].Needs, WiringNeed{ID: n.ID, ZoneID: n.ZoneID, FunctionTypeID: n.FunctionTypeID,
				Quantity: n.Quantity, PowerW: n.PowerW, LoadTypeID: n.LoadTypeID, Label: n.Label})
		}
	}
	for _, p := range placements {
		if i, ok := index[p.PlanID]; ok {
			out.Plans[i].Placements = append(out.Plans[i].Placements, WiringItem{ID: p.ID, VariantID: p.VariantID, Label: p.Label, ZoneID: p.ZoneID})
		}
	}
	rowPos := map[[2]uuid.UUID]int32{}
	for _, r := range rows {
		if i, ok := index[r.PlanID]; ok {
			out.Plans[i].Rows = append(out.Plans[i].Rows, WiringRow{ID: r.ID, Position: r.Position, CapacityTE: r.CapacityTe})
			rowPos[[2]uuid.UUID{r.PlanID, r.ID}] = r.Position
		}
	}
	for _, m := range modules {
		if i, ok := index[m.PlanID]; ok {
			out.Plans[i].Modules = append(out.Plans[i].Modules, WiringItem{ID: m.ID, VariantID: m.VariantID, Label: m.Label, RowID: m.RowID, OffsetTE: m.OffsetTe})
		}
	}
	for i := range out.Plans {
		p := &out.Plans[i]
		slices.SortStableFunc(p.Modules, func(a, b WiringItem) int {
			ra, rb := rowPos[[2]uuid.UUID{p.ID, a.RowID}], rowPos[[2]uuid.UUID{p.ID, b.RowID}]
			if ra != rb {
				return int(ra - rb)
			}
			switch {
			case a.OffsetTE < b.OffsetTE:
				return -1
			case a.OffsetTE > b.OffsetTE:
				return 1
			}
			return 0
		})
	}
	return out, nil
}
