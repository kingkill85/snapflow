package plans

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// NeedRef names a function type or load type of the summary.
type NeedRef struct {
	ID   uuid.UUID `json:"id"`
	Key  string    `json:"key"`
	Name i18n.Text `json:"name"`
}

// NullableNeedRef is a NeedRef that may be null (D245).
type NullableNeedRef struct {
	_ struct{} `nullable:"true"`
	NeedRef
}

// NeedTotals add up needs: units and power (quantity × power per unit, of
// the needs with a power).
type NeedTotals struct {
	Quantity int64   `json:"quantity" doc:"Units (sum of quantities)"`
	PowerW   float64 `json:"powerW" doc:"Sum of quantity × power per unit, of the needs with a power"`
}

// SummaryNeed is one need of the summary.
type SummaryNeed struct {
	ID           uuid.UUID        `json:"id"`
	FunctionType NeedRef          `json:"functionType"`
	LoadType     *NullableNeedRef `json:"loadType" doc:"null for none"`
	Quantity     int32            `json:"quantity"`
	PowerW       *float64         `json:"powerW" nullable:"true" doc:"Power per unit in W; null for unknown"`
	Label        string           `json:"label"`
	Note         string           `json:"note"`
	Symbol       bool             `json:"symbol" doc:"Drawn as a load symbol on the plan"`
}

// SummaryZone is a zone with its needs; zoneId null is "no zone" (load
// symbols outside every zone), listed last.
type SummaryZone struct {
	ZoneID *uuid.UUID    `json:"zoneId" nullable:"true"`
	Name   string        `json:"name" doc:"The zone's name; empty for no zone"`
	Needs  []SummaryNeed `json:"needs"`
	Totals NeedTotals    `json:"totals"`
}

// SummaryPlan is a plan with the zones that have needs.
type SummaryPlan struct {
	PlanID uuid.UUID     `json:"planId"`
	Name   string        `json:"name"`
	Zones  []SummaryZone `json:"zones" doc:"Zones with needs, in draw order; no zone last"`
	Totals NeedTotals    `json:"totals"`
}

// FunctionTypeTotal is the totals of one function type.
type FunctionTypeTotal struct {
	FunctionType NeedRef    `json:"functionType"`
	Totals       NeedTotals `json:"totals"`
}

// LoadTypeTotal is the totals of one load type (null: needs without one).
type LoadTypeTotal struct {
	LoadType *NullableNeedRef `json:"loadType"`
	Totals   NeedTotals       `json:"totals"`
}

// VersionNeeds is every need of a version, by plan and zone.
type VersionNeeds struct {
	Plans         []SummaryPlan       `json:"plans" doc:"Plans with needs, in plan order"`
	FunctionTypes []FunctionTypeTotal `json:"functionTypes" doc:"Totals per function type, by key"`
	LoadTypes     []LoadTypeTotal     `json:"loadTypes" doc:"Totals per load type, in load type order; without load type last"`
	Totals        NeedTotals          `json:"totals"`
}

func (t *NeedTotals) add(quantity int32, powerW *float64) {
	t.Quantity += int64(quantity)
	if powerW != nil {
		t.PowerW += float64(quantity) * *powerW
	}
}

// VersionNeeds returns the needs summary of a version (projects.read).
func (s *Service) VersionNeeds(ctx context.Context, versionID uuid.UUID) (VersionNeeds, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return VersionNeeds{}, err
	}
	var (
		planRows []store.BOMPlansRow
		zoneRows []store.BOMZonesRow
		needRows []store.VersionNeedsRow
	)
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		var err error
		if planRows, err = q.BOMPlans(ctx, versionID); err != nil {
			return err
		}
		if zoneRows, err = q.BOMZones(ctx, versionID); err != nil {
			return err
		}
		needRows, err = q.VersionNeeds(ctx, versionID)
		return err
	})
	if err != nil {
		return VersionNeeds{}, err
	}
	cat, err := s.needCatalog(ctx)
	if err != nil {
		return VersionNeeds{}, err
	}
	ftRef := func(id uuid.UUID) NeedRef {
		f := cat.functionTypes[id]
		return NeedRef{ID: id, Key: f.Key, Name: f.Name}
	}
	ltRef := func(id *uuid.UUID) *NullableNeedRef {
		if id == nil {
			return nil
		}
		l := cat.loadTypes[*id]
		return &NullableNeedRef{NeedRef: NeedRef{ID: *id, Key: l.Key, Name: l.Name}}
	}

	byPlan := map[uuid.UUID][]store.VersionNeedsRow{}
	for _, n := range needRows {
		byPlan[n.PlanID] = append(byPlan[n.PlanID], n)
	}
	zonesOf := map[uuid.UUID][]store.BOMZonesRow{}
	for _, z := range zoneRows {
		zonesOf[z.PlanID] = append(zonesOf[z.PlanID], z)
	}
	out := VersionNeeds{Plans: []SummaryPlan{}, FunctionTypes: []FunctionTypeTotal{}, LoadTypes: []LoadTypeTotal{}}
	ftTotals := map[uuid.UUID]*NeedTotals{}
	ltTotals := map[uuid.UUID]*NeedTotals{}
	var noLoadType *NeedTotals
	for _, p := range planRows {
		needs := byPlan[p.ID]
		if len(needs) == 0 {
			continue
		}
		plan := SummaryPlan{PlanID: p.ID, Name: p.Name, Zones: []SummaryZone{}}
		groups := map[uuid.UUID]*SummaryZone{}
		var none *SummaryZone
		for _, z := range zonesOf[p.ID] {
			groups[z.ID] = &SummaryZone{ZoneID: &z.ID, Name: z.Name, Needs: []SummaryNeed{}}
		}
		for _, n := range needs {
			g := none
			if n.ZoneID != nil {
				g = groups[*n.ZoneID]
			}
			if g == nil {
				if none == nil {
					none = &SummaryZone{Needs: []SummaryNeed{}}
				}
				g = none
			}
			g.Needs = append(g.Needs, SummaryNeed{ID: n.ID, FunctionType: ftRef(n.FunctionTypeID), LoadType: ltRef(n.LoadTypeID),
				Quantity: n.Quantity, PowerW: n.PowerW, Label: n.Label, Note: n.Note, Symbol: n.Symbol})
			g.Totals.add(n.Quantity, n.PowerW)
			plan.Totals.add(n.Quantity, n.PowerW)
			out.Totals.add(n.Quantity, n.PowerW)
			if ftTotals[n.FunctionTypeID] == nil {
				ftTotals[n.FunctionTypeID] = &NeedTotals{}
			}
			ftTotals[n.FunctionTypeID].add(n.Quantity, n.PowerW)
			if n.LoadTypeID == nil {
				if noLoadType == nil {
					noLoadType = &NeedTotals{}
				}
				noLoadType.add(n.Quantity, n.PowerW)
			} else {
				if ltTotals[*n.LoadTypeID] == nil {
					ltTotals[*n.LoadTypeID] = &NeedTotals{}
				}
				ltTotals[*n.LoadTypeID].add(n.Quantity, n.PowerW)
			}
		}
		for _, z := range zonesOf[p.ID] {
			if g := groups[z.ID]; len(g.Needs) > 0 {
				plan.Zones = append(plan.Zones, *g)
			}
		}
		if none != nil {
			plan.Zones = append(plan.Zones, *none)
		}
		out.Plans = append(out.Plans, plan)
	}
	for _, id := range cat.functionTypeOrder {
		if t := ftTotals[id]; t != nil {
			out.FunctionTypes = append(out.FunctionTypes, FunctionTypeTotal{FunctionType: ftRef(id), Totals: *t})
		}
	}
	for _, id := range cat.loadTypeOrder {
		if t := ltTotals[id]; t != nil {
			out.LoadTypes = append(out.LoadTypes, LoadTypeTotal{LoadType: ltRef(&id), Totals: *t})
		}
	}
	if noLoadType != nil {
		out.LoadTypes = append(out.LoadTypes, LoadTypeTotal{Totals: *noLoadType})
	}
	return out, nil
}
