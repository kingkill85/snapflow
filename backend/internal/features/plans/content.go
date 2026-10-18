package plans

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

var colorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Content returns a plan's zones and placements with their warnings.
func (s *Service) Content(ctx context.Context, id uuid.UUID) (PlanContent, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return PlanContent{}, err
	}
	st, err := s.stored(ctx, actor, id)
	if err != nil {
		return PlanContent{}, err
	}
	return s.contentOf(ctx, st.ref, st.plan, st.zones, st.placements)
}

// stored is a plan with its content as read in one snapshot.
type stored struct {
	ref        projects.VersionRef
	plan       store.GetPlanRow
	zones      []PlanZone
	placements []PlanPlacement
}

func (s *Service) stored(ctx context.Context, actor auth.Actor, id uuid.UUID) (stored, error) {
	var st stored
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if st.ref, err = s.readPlanVersion(ctx, actor, tx, q, id); err != nil {
			return err
		}
		if st.plan, err = q.GetPlan(ctx, id); err != nil {
			return notFound(err)
		}
		st.zones, st.placements, err = readContent(ctx, q, id)
		return err
	})
	return st, err
}

func readContent(ctx context.Context, q *store.Queries, id uuid.UUID) ([]PlanZone, []PlanPlacement, error) {
	zrows, err := q.ListZones(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	prows, err := q.ListPlacements(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	zones := make([]PlanZone, len(zrows))
	for i, z := range zrows {
		zones[i] = PlanZone{ID: z.ID, Name: z.Name, Color: z.Color, Opacity: z.Opacity}
		if err := json.Unmarshal(z.Points, &zones[i].Points); err != nil {
			return nil, nil, fmt.Errorf("plans: zone %s points: %w", z.ID, err)
		}
	}
	placements := make([]PlanPlacement, len(prows))
	for i, p := range prows {
		placements[i] = PlanPlacement{
			PlanPlacementInput: PlanPlacementInput{
				ID: p.ID, VariantID: p.VariantID, X: p.X, Y: p.Y, Width: p.Width, Height: p.Height, Rotation: p.Rotation,
				Label: p.Label, Existing: p.Existing, AddonVariantIDs: p.AddonVariantIds, InstanceValues: p.InstanceValues,
			},
			ZoneID: p.ZoneID,
		}
		if placements[i].AddonVariantIDs == nil {
			placements[i].AddonVariantIDs = []uuid.UUID{}
		}
		if placements[i].InstanceValues == nil {
			placements[i].InstanceValues = attrschema.Values{}
		}
	}
	return zones, placements, nil
}

// SaveContent replaces a plan's content (zones, placements, scale) as a
// whole in one transaction and returns it as stored, with the computed zones
// of the placements and the warnings. It needs the caller's live edit lock
// (plan.lock_required) and the content as last read (plan.stale).
func (s *Service) SaveContent(ctx context.Context, id uuid.UUID, in PlanContentInput) (PlanContent, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return PlanContent{}, err
	}
	// Check against the stored state first (fast failure, validation of
	// changes against the stored content); the transaction checks the
	// version again under the plan's lock, so the state validated against is
	// the state replaced.
	st, err := s.stored(ctx, actor, id)
	if err != nil {
		return PlanContent{}, err
	}
	if !st.ref.Writable() {
		return PlanContent{}, errReadOnly()
	}
	if err := s.requireLock(actor, st.plan.LockUserID, st.plan.LockExpiresAt); err != nil {
		return PlanContent{}, err
	}
	if !st.plan.ContentUpdatedAt.Equal(in.ExpectedContentUpdatedAt) {
		return PlanContent{}, errStale()
	}
	zones, placements, err := s.validateContent(ctx, st, in)
	if err != nil {
		return PlanContent{}, err
	}
	assignZones(zones, placements)

	var row store.GetPlanRow
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, st.plan.VersionID, false); err != nil {
			return err
		}
		locked, err := q.LockPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if err := s.requireLock(actor, locked.LockUserID, locked.LockExpiresAt); err != nil {
			return err
		}
		if !locked.ContentUpdatedAt.Equal(in.ExpectedContentUpdatedAt) {
			return errStale()
		}
		if err := writeContent(ctx, q, locked.TenantID, id, zones, placements); err != nil {
			return err
		}
		if _, err := q.TouchContent(ctx, store.TouchContentParams{ID: id, Scale: in.Scale}); err != nil {
			return err
		}
		row, err = q.GetPlan(ctx, id)
		return err
	})
	if err != nil {
		return PlanContent{}, err
	}
	return s.contentOf(ctx, st.ref, row, zones, placements)
}

// writeContent replaces the stored zones and placements (upsert by id and
// delete the missing ones, done as delete and insert: ids are per plan).
func writeContent(ctx context.Context, q *store.Queries, tenantID, planID uuid.UUID, zones []PlanZone, placements []PlanPlacement) error {
	if err := q.DeleteZones(ctx, planID); err != nil {
		return err
	}
	if err := q.DeletePlacements(ctx, planID); err != nil {
		return err
	}
	if len(zones) > 0 {
		type zoneRow struct {
			PlanZone
			Position int `json:"position"`
		}
		rows := make([]zoneRow, len(zones))
		for i, z := range zones {
			rows[i] = zoneRow{z, i + 1}
		}
		data, err := json.Marshal(rows)
		if err != nil {
			return err
		}
		if err := q.InsertZones(ctx, store.InsertZonesParams{TenantID: tenantID, PlanID: planID, Rows: data}); err != nil {
			return err
		}
	}
	if len(placements) > 0 {
		type placementRow struct {
			ID              uuid.UUID         `json:"id"`
			VariantID       *uuid.UUID        `json:"variant_id"`
			X               float64           `json:"x"`
			Y               float64           `json:"y"`
			Width           float64           `json:"width"`
			Height          float64           `json:"height"`
			Rotation        float64           `json:"rotation"`
			Label           string            `json:"label"`
			Existing        bool              `json:"existing"`
			AddonVariantIDs []uuid.UUID       `json:"addon_variant_ids"`
			InstanceValues  attrschema.Values `json:"instance_values"`
			ZoneID          *uuid.UUID        `json:"zone_id"`
			Position        int               `json:"position"`
		}
		rows := make([]placementRow, len(placements))
		for i, p := range placements {
			rows[i] = placementRow{
				ID: p.ID, VariantID: p.VariantID, X: p.X, Y: p.Y, Width: p.Width, Height: p.Height, Rotation: p.Rotation,
				Label: p.Label, Existing: p.Existing, AddonVariantIDs: p.AddonVariantIDs, InstanceValues: p.InstanceValues,
				ZoneID: p.ZoneID, Position: i + 1,
			}
			if rows[i].AddonVariantIDs == nil {
				rows[i].AddonVariantIDs = []uuid.UUID{}
			}
			if rows[i].InstanceValues == nil {
				rows[i].InstanceValues = attrschema.Values{}
			}
		}
		data, err := json.Marshal(rows)
		if err != nil {
			return err
		}
		if err := q.InsertPlacements(ctx, store.InsertPlacementsParams{TenantID: tenantID, PlanID: planID, Rows: data}); err != nil {
			return err
		}
	}
	return nil
}

// validateContent checks and normalises the content against the plan's
// image and the catalog. All problems are returned together, located at
// body.zones[i].… and body.placements[i].….
func (s *Service) validateContent(ctx context.Context, st stored, in PlanContentInput) ([]PlanZone, []PlanPlacement, error) {
	w, h := float64(st.plan.ImageWidth), float64(st.plan.ImageHeight)
	var errs []apperr.FieldError
	add := func(loc, code, detail string, params ...any) {
		f := apperr.Field(loc, code, detail)
		for i := 0; i+1 < len(params); i += 2 {
			f = f.With(params[i].(string), params[i+1])
		}
		errs = append(errs, f)
	}
	if len(in.Zones) > MaxZones {
		add("body.zones", "validation.too_many", "too many zones", "max", MaxZones)
	}
	if len(in.Placements) > MaxPlacements {
		add("body.placements", "validation.too_many", "too many placements", "max", MaxPlacements)
	}
	if len(errs) > 0 {
		return nil, nil, apperr.Validation(errs...)
	}
	if in.Scale != nil && (!finite(*in.Scale) || *in.Scale <= 0) {
		add("body.scale", "validation.invalid", "the scale must be above 0")
	}
	inside := func(x, y float64) bool { return x >= 0 && x <= w && y >= 0 && y <= h }

	zones := make([]PlanZone, len(in.Zones))
	seen := map[uuid.UUID]bool{}
	for i, z := range in.Zones {
		loc := fmt.Sprintf("body.zones[%d]", i)
		if seen[z.ID] || z.ID == uuid.Nil {
			add(loc+".id", "plan.duplicate_id", "the id is used twice")
		}
		seen[z.ID] = true
		z.Name = strings.TrimSpace(z.Name)
		if f := checkText(loc+".name", z.Name, MaxNameLength, true); f != nil {
			errs = append(errs, *f)
		}
		if !colorPattern.MatchString(z.Color) {
			add(loc+".color", "plan.zone_color", "use #rrggbb")
		}
		z.Color = strings.ToLower(z.Color)
		if !finite(z.Opacity) || z.Opacity < 0 || z.Opacity > 1 {
			add(loc+".opacity", "plan.zone_opacity", "the opacity must be 0-1")
		}
		errs = append(errs, checkPolygon(loc+".points", z.Points, inside)...)
		zones[i] = z
	}

	// The catalog facts of every variant sent or stored.
	stored := make(map[uuid.UUID]PlanPlacement, len(st.placements))
	for _, p := range st.placements {
		stored[p.ID] = p
	}
	var variantIDs []uuid.UUID
	for _, p := range in.Placements {
		if p.VariantID != nil {
			variantIDs = append(variantIDs, *p.VariantID)
		}
	}
	slices.SortFunc(variantIDs, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	variants, err := s.products.PlacementVariants(ctx, slices.Compact(variantIDs))
	if err != nil {
		return nil, nil, err
	}

	placements := make([]PlanPlacement, len(in.Placements))
	seen = map[uuid.UUID]bool{}
	for i, p := range in.Placements {
		loc := fmt.Sprintf("body.placements[%d]", i)
		if seen[p.ID] || p.ID == uuid.Nil {
			add(loc+".id", "plan.duplicate_id", "the id is used twice")
		}
		seen[p.ID] = true
		prev, wasStored := stored[p.ID]
		if !finite(p.X, p.Y) || !inside(p.X, p.Y) {
			add(loc+".x", "plan.outside_image", "the centre must be inside the image")
		}
		if !finite(p.Width) || p.Width <= 0 || p.Width > w {
			add(loc+".width", "plan.placement_size", "the width must be above 0 and at most the image width", "max", int(w))
		}
		if !finite(p.Height) || p.Height <= 0 || p.Height > h {
			add(loc+".height", "plan.placement_size", "the height must be above 0 and at most the image height", "max", int(h))
		}
		if !finite(p.Rotation) {
			add(loc+".rotation", "validation.invalid", "the rotation must be a number")
		} else {
			p.Rotation = normalizeRotation(p.Rotation)
		}
		p.Label = strings.TrimSpace(p.Label)
		if f := checkText(loc+".label", p.Label, MaxLabelLength, false); f != nil {
			errs = append(errs, *f)
		}

		// The variant: a deleted one (stored as null) may stay null; a
		// variant deleted since the editor loaded it is kept as deleted.
		var v *products.PlacementVariant
		if p.VariantID == nil {
			if !wasStored || prev.VariantID != nil {
				add(loc+".variantId", "plan.variant_required", "choose a product")
			}
		} else if found, ok := variants[*p.VariantID]; ok {
			v = &found
		} else if wasStored && prev.VariantID == nil {
			p.VariantID = nil
		} else {
			add(loc+".variantId", "plan.variant_not_found", "no such variant")
		}
		var prevAddons []uuid.UUID
		var prevValues attrschema.Values
		if wasStored && prev.VariantID != nil && p.VariantID != nil && *prev.VariantID == *p.VariantID {
			prevAddons, prevValues = prev.AddonVariantIDs, prev.InstanceValues
		}
		if v == nil {
			// No catalog facts: keep what was stored for the same variant.
			p.AddonVariantIDs, p.InstanceValues = prevAddons, prevValues
		} else {
			p.AddonVariantIDs, errs = checkAddons(loc+".addonVariantIds", *v, p.AddonVariantIDs, prevAddons, errs)
			var valueErrs []apperr.FieldError
			p.InstanceValues, valueErrs = instanceValues(v.InstanceAttributes, p.InstanceValues, prevValues, loc+".instanceValues")
			errs = append(errs, valueErrs...)
		}
		placements[i] = PlanPlacement{PlanPlacementInput: p}
	}
	if len(errs) > 0 {
		return nil, nil, apperr.Validation(errs...)
	}
	return zones, placements, nil
}

// checkAddons keeps the chosen optional add-ons that are add-on links of the
// variant, in the order sent, without duplicates and without required ones
// (those are implied). An id that is no longer a link but was stored for the
// placement is kept (warning addon_not_linked, like stale attribute values,
// D31); a new one is plan.addon_not_linked.
func checkAddons(loc string, v products.PlacementVariant, ids, previous []uuid.UUID, errs []apperr.FieldError) ([]uuid.UUID, []apperr.FieldError) {
	if len(ids) > MaxAddons {
		return nil, append(errs, apperr.Field(loc, "validation.too_many", "too many add-ons").With("max", MaxAddons))
	}
	out := []uuid.UUID{}
	for i, id := range ids {
		if slices.Contains(out, id) {
			continue
		}
		link := slices.IndexFunc(v.Addons, func(a products.PlacementAddon) bool { return a.AddonVariantID == id })
		switch {
		case link >= 0 && v.Addons[link].Required:
			continue
		case link >= 0 || slices.Contains(previous, id):
			out = append(out, id)
		default:
			errs = append(errs, apperr.Field(fmt.Sprintf("%s[%d]", loc, i), "plan.addon_not_linked", "not an add-on of this variant"))
		}
	}
	return out, errs
}

// instanceValues validates the values of an installed unit against the
// category's instance schema. Keys the schema no longer has are kept with
// their stored value (D31); new unknown keys are attribute.unknown.
func instanceValues(schema attrschema.InstanceSchema, in, previous attrschema.Values, loc string) (attrschema.Values, []apperr.FieldError) {
	valid, stale, errs := attrschema.ValidateInstanceValues(schema, in, loc, attrschema.Options{Unknown: attrschema.UnknownKeep})
	keys := make([]string, 0, len(stale))
	for k := range stale {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if old, ok := previous[k]; ok {
			valid[k] = old
			continue
		}
		errs = append(errs, apperr.Field(loc+"."+k, "attribute.unknown", "no such attribute"))
	}
	if valid == nil {
		valid = attrschema.Values{}
	}
	return valid, errs
}

// checkPolygon checks a zone's polygon: 3-200 points, all finite and inside
// the image, at least 3 distinct ones and an area above 0. Self-crossing
// polygons are accepted (D196).
func checkPolygon(loc string, pts [][2]float64, inside func(x, y float64) bool) []apperr.FieldError {
	if len(pts) < MinZonePoints || len(pts) > MaxZonePoints {
		return []apperr.FieldError{apperr.Field(loc, "plan.zone_points", "a zone needs 3-200 points").
			With("min", MinZonePoints).With("max", MaxZonePoints)}
	}
	for i, p := range pts {
		if !finite(p[0], p[1]) || !inside(p[0], p[1]) {
			return []apperr.FieldError{apperr.Field(fmt.Sprintf("%s[%d]", loc, i), "plan.outside_image", "the point must be inside the image")}
		}
	}
	distinct := map[[2]float64]bool{}
	for _, p := range pts {
		distinct[p] = true
	}
	if len(distinct) < MinZonePoints || polygonArea(pts) <= 0 {
		return []apperr.FieldError{apperr.Field(loc, "plan.zone_degenerate", "the zone has no area")}
	}
	return nil
}

func checkText(loc, s string, maxLen int, required bool) *apperr.FieldError {
	var f apperr.FieldError
	switch {
	case required && s == "":
		f = apperr.Field(loc, "validation.required", "required")
	case len([]rune(s)) > maxLen:
		f = apperr.Field(loc, "validation.too_long", "too long").With("max", maxLen)
	case strings.ContainsFunc(s, unicode.IsControl):
		f = apperr.Field(loc, "validation.control_chars", "control characters are not allowed")
	default:
		return nil
	}
	return &f
}

// contentOf builds the response of a plan's content with its warnings.
func (s *Service) contentOf(ctx context.Context, ref projects.VersionRef, plan store.GetPlanRow, zones []PlanZone, placements []PlanPlacement) (PlanContent, error) {
	warnings, err := s.warnings(ctx, ref, placements)
	if err != nil {
		return PlanContent{}, err
	}
	if zones == nil {
		zones = []PlanZone{}
	}
	if placements == nil {
		placements = []PlanPlacement{}
	}
	return PlanContent{
		PlanID: plan.ID, ContentUpdatedAt: plan.ContentUpdatedAt, Scale: plan.Scale,
		Zones: zones, Placements: placements, Warnings: warnings,
	}, nil
}

// warnings lists what is wrong with the placements' catalog references
// (D54): unavailable variants (by the first inactive level), product types
// the project does not use, unavailable add-ons and add-ons no longer
// linked.
func (s *Service) warnings(ctx context.Context, ref projects.VersionRef, placements []PlanPlacement) ([]PlanWarning, error) {
	var ids []uuid.UUID
	for _, p := range placements {
		if p.VariantID != nil {
			ids = append(ids, *p.VariantID)
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	variants, err := s.products.PlacementVariants(ctx, slices.Compact(ids))
	if err != nil {
		return nil, err
	}
	out := []PlanWarning{}
	for _, p := range placements {
		warn := func(code PlanWarningCode, addon *uuid.UUID) {
			out = append(out, PlanWarning{PlacementID: p.ID, Code: code, AddonVariantID: addon})
		}
		if p.VariantID == nil {
			warn(WarnVariantDeleted, nil)
			continue
		}
		v, ok := variants[*p.VariantID]
		if !ok {
			warn(WarnVariantDeleted, nil)
			continue
		}
		switch {
		case !v.TypeActive:
			warn(WarnProductTypeInactive, nil)
		case !v.CategoryActive:
			warn(WarnCategoryInactive, nil)
		case !v.ProductActive:
			warn(WarnProductInactive, nil)
		case !v.VariantActive:
			warn(WarnVariantInactive, nil)
		}
		if !slices.Contains(ref.ProductTypeIDs, v.ProductTypeID) {
			warn(WarnProductTypeNotInProject, nil)
		}
		for _, a := range v.Addons {
			if a.Required && !a.Available {
				warn(WarnRequiredAddonUnavailable, &a.AddonVariantID)
			}
		}
		for _, id := range p.AddonVariantIDs {
			link := slices.IndexFunc(v.Addons, func(a products.PlacementAddon) bool { return a.AddonVariantID == id })
			switch {
			case link < 0:
				warn(WarnAddonNotLinked, &id)
			case !v.Addons[link].Available:
				warn(WarnAddonUnavailable, &id)
			}
		}
	}
	return out, nil
}

// scaleContent fits a plan's content to a new image size (D194): positions
// and zone corners scale per axis, so everything keeps its place on the
// drawing; sizes scale by the geometric mean of both factors (no distortion
// of the product symbols), at most the new image size. The scale (metres per
// pixel) follows when the aspect ratio stayed (within 1 %), else it is
// cleared (the calibration no longer holds). The content version moves on,
// so an open editor reloads.
func (s *Service) scaleContent(ctx context.Context, q *store.Queries, plan store.Plan, width, height int32) error {
	sx := float64(width) / float64(plan.ImageWidth)
	sy := float64(height) / float64(plan.ImageHeight)
	scale := plan.Scale
	if sx != 1 || sy != 1 {
		zones, placements, err := readContent(ctx, q, plan.ID)
		if err != nil {
			return err
		}
		clampX := func(x float64) float64 { return math.Min(math.Max(x*sx, 0), float64(width)) }
		clampY := func(y float64) float64 { return math.Min(math.Max(y*sy, 0), float64(height)) }
		for i := range zones {
			for j, p := range zones[i].Points {
				zones[i].Points[j] = [2]float64{clampX(p[0]), clampY(p[1])}
			}
		}
		f := math.Sqrt(sx * sy)
		for i := range placements {
			p := &placements[i]
			p.X, p.Y = clampX(p.X), clampY(p.Y)
			p.Width = math.Min(p.Width*f, float64(width))
			p.Height = math.Min(p.Height*f, float64(height))
		}
		assignZones(zones, placements)
		if err := writeContent(ctx, q, plan.TenantID, plan.ID, zones, placements); err != nil {
			return err
		}
		if scale != nil {
			if math.Abs(sx-sy)/math.Max(sx, sy) <= 0.01 {
				v := *scale / f
				scale = &v
			} else {
				scale = nil
			}
		}
	}
	_, err := q.TouchContent(ctx, store.TouchContentParams{ID: plan.ID, Scale: scale})
	return err
}

// CopyVersion copies the plans of source with their zones and placements
// into target (projects.Service.OnCopyVersion): new ids for plans, zones and
// placements, the same image files (files are immutable), no locks.
func (s *Service) CopyVersion(ctx context.Context, tx pgx.Tx, source, target projects.VersionRef) error {
	if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
		return err
	}
	q := s.q.WithTx(tx)
	ids, err := q.PlanIDsForCopy(ctx, source.ID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		newID, err := q.CopyPlan(ctx, store.CopyPlanParams{TenantID: target.TenantID, VersionID: target.ID, ID: id})
		if err != nil {
			return err
		}
		zones, placements, err := readContent(ctx, q, id)
		if err != nil {
			return err
		}
		zoneIDs := make(map[uuid.UUID]uuid.UUID, len(zones))
		for i := range zones {
			zoneIDs[zones[i].ID] = uuid.New()
			zones[i].ID = zoneIDs[zones[i].ID]
		}
		for i := range placements {
			placements[i].ID = uuid.New()
			if z := placements[i].ZoneID; z != nil {
				nz := zoneIDs[*z]
				placements[i].ZoneID = &nz
			}
		}
		if err := writeContent(ctx, q, target.TenantID, newID, zones, placements); err != nil {
			return err
		}
	}
	return nil
}
