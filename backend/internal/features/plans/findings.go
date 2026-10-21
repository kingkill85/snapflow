package plans

import (
	"context"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
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
	// Nothing can be ordered, or the board cannot be installed as drawn
	// (amends D374: saving still accepts overlap and overflow).
	string(WarnVariantDeleted): SeverityError,
	string(WarnModuleOverlap):  SeverityError,
	string(WarnRowOverflow):    SeverityError,
	// The catalog changed under the plan: review.
	string(WarnVariantInactive):          SeverityWarning,
	string(WarnProductInactive):          SeverityWarning,
	string(WarnCategoryInactive):         SeverityWarning,
	string(WarnProductTypeInactive):      SeverityWarning,
	string(WarnProductTypeNotInProject):  SeverityWarning,
	string(WarnAddonUnavailable):         SeverityWarning,
	string(WarnAddonNotLinked):           SeverityWarning,
	string(WarnModuleMountingFloorplan):  SeverityWarning,
	string(WarnRequiredAddonUnavailable): SeverityWarning,
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
	// AddonProductName and AddonVariantName name the add-on (nil when the
	// catalog no longer has it).
	AddonProductName, AddonVariantName *i18n.Text
}

// ContentFindings returns the content warnings of every plan of a version
// (floorplans: placements and needs; boards: modules and enclosure), in plan
// order. The wiring checks include them (D453). Each plan is read in its own
// snapshot, apart from the checks' snapshot of the version.
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
	return s.nameAddons(ctx, out)
}

// nameAddons adds the names of the add-ons of add-on warnings (one catalog
// lookup).
func (s *Service) nameAddons(ctx context.Context, list []ContentFinding) ([]ContentFinding, error) {
	var ids []uuid.UUID
	for _, f := range list {
		if f.AddonVariantID != nil {
			ids = append(ids, *f.AddonVariantID)
		}
	}
	if len(ids) == 0 {
		return list, nil
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	variants, err := s.products.BOMVariants(ctx, slices.Compact(ids))
	if err != nil {
		return nil, err
	}
	for i, f := range list {
		if f.AddonVariantID == nil {
			continue
		}
		if v, ok := variants[*f.AddonVariantID]; ok {
			pn, vn := v.ProductName, v.VariantName
			list[i].AddonProductName, list[i].AddonVariantName = &pn, &vn
		}
	}
	return list, nil
}
