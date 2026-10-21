package wiring

import (
	"testing"

	"github.com/google/uuid"
)

// ?planId= (D453): a connection finding (need on the floorplan, channel on
// the board) is in both plans' lists, a need finding under its plan only, a
// line finding in neither; the counts follow the list.
func TestFilterPlan(t *testing.T) {
	floor, board, need, item := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	all := Checks{Findings: []Finding{
		{Severity: SeverityError, Code: "channel_overload_w", Refs: Refs{PlanID: &floor, NeedID: &need, TargetPlanID: &board, ItemID: &item}},
		{Severity: SeverityWarning, Code: "need_outside_zones", Refs: Refs{PlanID: &floor, NeedID: &need}},
		{Severity: SeverityInfo, Code: "module_width_unknown", Refs: Refs{TargetPlanID: &board, ItemID: &item}},
		{Severity: SeverityWarning, Code: CodeBusLineNoPowerSupply, Refs: Refs{}},
	}}
	codes := func(planID uuid.UUID) (out []string, c CheckCounts) {
		cp := all
		cp.Findings = append([]Finding(nil), all.Findings...)
		filterPlan(&cp, planID)
		for _, f := range cp.Findings {
			out = append(out, f.Code)
		}
		return out, cp.Counts
	}
	got, c := codes(floor)
	if len(got) != 2 || got[0] != "channel_overload_w" || got[1] != "need_outside_zones" || c.Errors != 1 || c.Warnings != 1 || c.Infos != 0 {
		t.Errorf("floor: %v %+v", got, c)
	}
	got, c = codes(board)
	if len(got) != 2 || got[0] != "channel_overload_w" || got[1] != "module_width_unknown" || c.Errors != 1 || c.Infos != 1 {
		t.Errorf("board: %v %+v", got, c)
	}
	if got, _ = codes(uuid.New()); len(got) != 0 {
		t.Errorf("other: %v", got)
	}
}
