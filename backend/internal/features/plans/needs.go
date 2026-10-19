package plans

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// needCatalog holds the catalog facts needs are checked against: function
// types (active flag, allowed load types) and load types. Read through their
// services before any transaction (D243).
type needCatalog struct {
	functionTypes map[uuid.UUID]functiontypes.FunctionType
	loadTypes     map[uuid.UUID]capabilities.LoadType
	// Order of function types (by key) and load types (sort order).
	functionTypeOrder []uuid.UUID
	loadTypeOrder     []uuid.UUID
}

func (s *Service) needCatalog(ctx context.Context) (needCatalog, error) {
	fts, err := s.functionTypes.List(ctx)
	if err != nil {
		return needCatalog{}, err
	}
	lts, err := s.capabilities.LoadTypes(ctx, true)
	if err != nil {
		return needCatalog{}, err
	}
	c := needCatalog{functionTypes: map[uuid.UUID]functiontypes.FunctionType{}, loadTypes: map[uuid.UUID]capabilities.LoadType{}}
	for _, f := range fts {
		c.functionTypes[f.ID] = f
		c.functionTypeOrder = append(c.functionTypeOrder, f.ID)
	}
	for _, l := range lts {
		c.loadTypes[l.ID] = l
		c.loadTypeOrder = append(c.loadTypeOrder, l.ID)
	}
	return c, nil
}

// loadTypeAllowed: the function type lists no load types (any) or lists id.
func (c needCatalog) loadTypeAllowed(ft functiontypes.FunctionType, id uuid.UUID) bool {
	return len(ft.LoadTypeIDs) == 0 || slices.Contains(ft.LoadTypeIDs, id)
}

func readNeeds(ctx context.Context, q *store.Queries, id uuid.UUID) ([]PlanNeed, error) {
	rows, err := q.ListNeeds(ctx, id)
	if err != nil {
		return nil, err
	}
	out := make([]PlanNeed, len(rows))
	for i, r := range rows {
		out[i] = PlanNeed{
			ID: r.ID, ZoneID: r.ZoneID, FunctionTypeID: r.FunctionTypeID, Quantity: r.Quantity, PowerW: r.PowerW,
			LoadTypeID: r.LoadTypeID, Label: r.Label, Note: r.Note, X: r.X, Y: r.Y,
		}
	}
	return out, nil
}

// writeNeeds replaces the stored needs of a plan.
func writeNeeds(ctx context.Context, q *store.Queries, tenantID, planID uuid.UUID, needs []PlanNeed) error {
	if err := q.DeleteNeeds(ctx, planID); err != nil {
		return err
	}
	if len(needs) == 0 {
		return nil
	}
	type needRow struct {
		ID             uuid.UUID  `json:"id"`
		FunctionTypeID uuid.UUID  `json:"function_type_id"`
		Quantity       int32      `json:"quantity"`
		PowerW         *float64   `json:"power_w"`
		LoadTypeID     *uuid.UUID `json:"load_type_id"`
		Label          string     `json:"label"`
		Note           string     `json:"note"`
		X              *float64   `json:"x"`
		Y              *float64   `json:"y"`
		ZoneID         *uuid.UUID `json:"zone_id"`
		Position       int        `json:"position"`
	}
	rows := make([]needRow, len(needs))
	for i, n := range needs {
		rows[i] = needRow{ID: n.ID, FunctionTypeID: n.FunctionTypeID, Quantity: n.Quantity, PowerW: n.PowerW,
			LoadTypeID: n.LoadTypeID, Label: n.Label, Note: n.Note, X: n.X, Y: n.Y, ZoneID: n.ZoneID, Position: i + 1}
	}
	data, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	return q.InsertNeeds(ctx, store.InsertNeedsParams{TenantID: tenantID, PlanID: planID, Rows: data})
}

// assignNeedZones sets the zone of every load symbol from its position
// (same rule as placements: the smallest containing zone).
func assignNeedZones(zones []PlanZone, needs []PlanNeed) {
	areas := make([]float64, len(zones))
	for i, z := range zones {
		areas[i] = polygonArea(z.Points)
	}
	for i := range needs {
		if needs[i].X != nil && needs[i].Y != nil {
			needs[i].ZoneID = zoneOf(zones, areas, [2]float64{*needs[i].X, *needs[i].Y})
		}
	}
}

// keptNeeds are the stored needs when a save leaves needs out (D294): the
// needs of zones that no longer exist go with their zone.
func keptNeeds(stored []PlanNeed, zones []PlanZone) []PlanNeed {
	out := []PlanNeed{}
	for _, n := range stored {
		if n.X == nil && n.ZoneID != nil && !slices.ContainsFunc(zones, func(z PlanZone) bool { return z.ID == *n.ZoneID }) {
			continue
		}
		out = append(out, n)
	}
	return out
}

// validateNeeds checks the needs of a content save (field errors at
// body.needs[i].…). A stored need keeps an inactive function type and a load
// type its function type no longer allows (warnings); new or changed ones
// must be valid now.
func validateNeeds(cat needCatalog, in, stored []PlanNeed, zones []PlanZone, w, h float64) ([]PlanNeed, []apperr.FieldError) {
	var errs []apperr.FieldError
	add := func(loc, code, detail string, params ...any) {
		f := apperr.Field(loc, code, detail)
		for i := 0; i+1 < len(params); i += 2 {
			f = f.With(params[i].(string), params[i+1])
		}
		errs = append(errs, f)
	}
	if len(in) > MaxNeeds {
		add("body.needs", "validation.too_many", "too many needs", "max", MaxNeeds)
		return nil, errs
	}
	prev := make(map[uuid.UUID]PlanNeed, len(stored))
	for _, n := range stored {
		prev[n.ID] = n
	}
	zoneIDs := make(map[uuid.UUID]bool, len(zones))
	for _, z := range zones {
		zoneIDs[z.ID] = true
	}
	out := make([]PlanNeed, len(in))
	seen := map[uuid.UUID]bool{}
	for i, n := range in {
		loc := fmt.Sprintf("body.needs[%d]", i)
		if seen[n.ID] || n.ID == uuid.Nil {
			add(loc+".id", "plan.duplicate_id", "the id is used twice")
		}
		seen[n.ID] = true
		old, wasStored := prev[n.ID]
		sameFunction := wasStored && old.FunctionTypeID == n.FunctionTypeID

		ft, ok := cat.functionTypes[n.FunctionTypeID]
		switch {
		case !ok:
			add(loc+".functionTypeId", "function_type.not_found", "no such function type")
		case !ft.IsActive && !sameFunction:
			add(loc+".functionTypeId", "need.function_type_inactive", "the function type is inactive")
		}
		if n.Quantity < 1 || n.Quantity > MaxNeedQty {
			add(loc+".quantity", "validation.range", "quantity out of range", "min", 1, "max", MaxNeedQty)
		}
		if n.PowerW != nil && (!finite(*n.PowerW) || *n.PowerW < 0 || *n.PowerW > MaxNeedPowerW) {
			add(loc+".powerW", "validation.range", "power out of range", "min", 0, "max", MaxNeedPowerW)
		}
		if n.LoadTypeID != nil {
			lt, found := cat.loadTypes[*n.LoadTypeID]
			unchanged := sameFunction && old.LoadTypeID != nil && *old.LoadTypeID == *n.LoadTypeID
			switch {
			case !found:
				add(loc+".loadTypeId", "load_type.not_found", "no such load type")
			case unchanged:
				// Kept as stored (warning need_load_type_not_allowed if the
				// function type no longer allows it).
			case !lt.IsActive:
				add(loc+".loadTypeId", "need.load_type_inactive", "the load type is inactive")
			case ok && !cat.loadTypeAllowed(ft, *n.LoadTypeID):
				add(loc+".loadTypeId", "need.load_type_not_allowed", "the function type does not allow this load type")
			}
		}
		n.Label = strings.TrimSpace(n.Label)
		if f := checkText(loc+".label", n.Label, MaxLabelLength, false); f != nil {
			errs = append(errs, *f)
		}
		n.Note = strings.TrimSpace(n.Note)
		if f := checkText(loc+".note", n.Note, MaxNoteLength, false); f != nil {
			errs = append(errs, *f)
		}
		switch {
		case (n.X == nil) != (n.Y == nil):
			add(loc+".x", "need.position_partial", "give both x and y or neither")
		case n.X != nil:
			if !finite(*n.X, *n.Y) || *n.X < 0 || *n.X > w || *n.Y < 0 || *n.Y > h {
				add(loc+".x", "plan.outside_image", "the position must be inside the image")
			}
			n.ZoneID = nil // computed
		case n.ZoneID == nil:
			add(loc+".zoneId", "validation.required", "a need without position needs a zone")
		case !zoneIDs[*n.ZoneID]:
			add(loc+".zoneId", "need.zone_not_found", "no such zone in this content")
		}
		out[i] = n
	}
	return out, errs
}

// needWarnings lists what is wrong with the needs (never blocks a save).
func needWarnings(cat needCatalog, needs []PlanNeed) []NeedWarning {
	out := []NeedWarning{}
	for _, n := range needs {
		ft, ok := cat.functionTypes[n.FunctionTypeID]
		if ok && !ft.IsActive {
			out = append(out, NeedWarning{NeedID: n.ID, Code: WarnNeedFunctionTypeInactive})
		}
		if ok && n.LoadTypeID != nil && !cat.loadTypeAllowed(ft, *n.LoadTypeID) {
			out = append(out, NeedWarning{NeedID: n.ID, Code: WarnNeedLoadTypeNotAllowed})
		}
		if n.X != nil && n.ZoneID == nil {
			out = append(out, NeedWarning{NeedID: n.ID, Code: WarnNeedOutsideZones})
		}
	}
	return out
}
