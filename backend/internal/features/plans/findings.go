package plans

import (
	"context"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// FindingSeverity is how much a plan content warning matters in the checks
// (D453): error, warning or info, like every other finding.
type FindingSeverity string

const (
	SeverityError   FindingSeverity = "error"
	SeverityWarning FindingSeverity = "warning"
	SeverityInfo    FindingSeverity = "info"
)

// WarningSeverity is the severity of every plan content warning code (the
// placement, need and board codes; one namespace with the checks codes,
// D453). The checks endpoint reports the warnings as findings with it.
var WarningSeverity = map[string]FindingSeverity{
	// Nothing can be ordered or a module physically does not fit.
	string(WarnVariantDeleted):           SeverityError,
	string(WarnModuleOverlap):            SeverityError,
	string(WarnRequiredAddonUnavailable): SeverityError,
	// The catalog changed under the plan: review.
	string(WarnVariantInactive):          SeverityWarning,
	string(WarnProductInactive):          SeverityWarning,
	string(WarnCategoryInactive):         SeverityWarning,
	string(WarnProductTypeInactive):      SeverityWarning,
	string(WarnProductTypeNotInProject):  SeverityWarning,
	string(WarnAddonUnavailable):         SeverityWarning,
	string(WarnAddonNotLinked):           SeverityWarning,
	string(WarnModuleMountingFloorplan):  SeverityWarning,
	string(WarnRowOverflow):              SeverityWarning,
	string(WarnNeedFunctionTypeInactive): SeverityWarning,
	string(WarnNeedLoadTypeNotAllowed):   SeverityWarning,
	string(WarnNeedOutsideZones):         SeverityWarning,
	// Data the catalog lacks; the editor works around it.
	string(WarnModuleWidthUnknown):   SeverityInfo,
	string(WarnEnclosureSizeUnknown): SeverityInfo,
}

// ContentFinding is one content warning of a plan as the checks report it.
type ContentFinding struct {
	PlanID   uuid.UUID
	PlanKind string
	Severity FindingSeverity
	Code     string
	// ItemID is the placement or module; NeedID the need; both nil for a
	// warning of the board's enclosure.
	ItemID         *uuid.UUID
	NeedID         *uuid.UUID
	AddonVariantID *uuid.UUID
}

// ContentFindings returns the content warnings of every plan of a version
// (floorplans: placements and needs; boards: modules and enclosure), in plan
// order. The wiring checks include them (D453).
func (s *Service) ContentFindings(ctx context.Context, versionID uuid.UUID) ([]ContentFinding, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return nil, err
	}
	list, err := s.List(ctx, versionID)
	if err != nil {
		return nil, err
	}
	out := []ContentFinding{}
	add := func(p Plan, code string, item, need, addon *uuid.UUID) {
		out = append(out, ContentFinding{PlanID: p.ID, PlanKind: p.Kind, Severity: WarningSeverity[code], Code: code, ItemID: item, NeedID: need, AddonVariantID: addon})
	}
	for _, p := range list {
		if p.Kind == "board" {
			c, err := s.BoardContent(ctx, p.ID)
			if err != nil {
				return nil, err
			}
			for _, w := range c.Warnings {
				add(p, string(w.Code), w.ModuleID, nil, w.AddonVariantID)
			}
			continue
		}
		c, err := s.Content(ctx, p.ID)
		if err != nil {
			return nil, err
		}
		for _, w := range c.Warnings {
			id := w.PlacementID
			add(p, string(w.Code), &id, nil, w.AddonVariantID)
		}
		for _, w := range c.NeedWarnings {
			id := w.NeedID
			add(p, string(w.Code), nil, &id, nil)
		}
	}
	return out, nil
}
