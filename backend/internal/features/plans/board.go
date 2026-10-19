package plans

// Distribution boards (step 3c): a board plan holds rows of DIN rail and the
// modules placed on them, saved as one document like a floorplan's content
// (same edit lock, contentUpdatedAt stale check and read-only rules).

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// teEpsilon absorbs float noise of one-decimal TE values.
const teEpsilon = 1e-6

// boardCatalog is what a board is checked against, read before any
// transaction (D243).
type boardCatalog struct {
	variants map[uuid.UUID]products.PlacementVariant
	caps     map[uuid.UUID]capabilities.Capabilities
}

func (s *Service) boardCatalog(ctx context.Context, ids []uuid.UUID) (boardCatalog, error) {
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	ids = slices.Compact(ids)
	v, err := s.products.PlacementVariants(ctx, ids)
	if err != nil {
		return boardCatalog{}, err
	}
	c := map[uuid.UUID]capabilities.Capabilities{}
	if len(ids) > 0 {
		if c, err = s.products.Capabilities(ctx, ids); err != nil {
			return boardCatalog{}, err
		}
	}
	return boardCatalog{variants: v, caps: c}, nil
}

// width is a module's width in TE: its railWidthTe, 1 when unknown.
func (c boardCatalog) width(variantID *uuid.UUID) (float64, bool) {
	if variantID != nil {
		if cp, ok := c.caps[*variantID]; ok && cp.RailWidthTE != nil && *cp.RailWidthTE > 0 {
			return *cp.RailWidthTE, true
		}
	}
	return 1, false
}

// enclosureSize is the rows x TE per row of an enclosure, ok when both are
// known.
func (c boardCatalog) enclosureSize(variantID *uuid.UUID) (rows int, te float64, ok bool) {
	if variantID == nil {
		return 0, 0, false
	}
	cp, found := c.caps[*variantID]
	if !found || cp.EnclosureRows == nil || cp.EnclosureTEPerRow == nil {
		return 0, 0, false
	}
	rows, te = int(math.Floor(*cp.EnclosureRows)), roundTE(*cp.EnclosureTEPerRow)
	if rows < 1 || rows > MaxBoardRows || te <= 0 || te > MaxRowTE {
		return 0, 0, false
	}
	return rows, te, true
}

func roundTE(v float64) float64 { return math.Round(v*10) / 10 }

// oneDecimal reports whether v has at most one decimal.
func oneDecimal(v float64) bool {
	return finite(v) && math.Abs(v*10-math.Round(v*10)) < teEpsilon*10
}

// ---------------------------------------------------------------- create

// CreateBoard adds a board plan at the end of the version's plans, with the
// rows of its enclosure (known size) or the rows given.
func (s *Service) CreateBoard(ctx context.Context, versionID uuid.UUID, in BoardCreate) (Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Plan{}, err
	}
	name, err := validateName(in.Name)
	if err != nil {
		return Plan{}, err
	}
	var ids []uuid.UUID
	if in.EnclosureVariantID != nil {
		ids = append(ids, *in.EnclosureVariantID)
	}
	cat, err := s.boardCatalog(ctx, ids)
	if err != nil {
		return Plan{}, err
	}
	var errs []apperr.FieldError
	if in.EnclosureVariantID != nil {
		if _, ok := cat.variants[*in.EnclosureVariantID]; !ok {
			errs = append(errs, apperr.Field("body.enclosureVariantId", "board.enclosure_not_found", "no such variant"))
		}
	}
	var rows []BoardRowInput
	if n, te, ok := cat.enclosureSize(in.EnclosureVariantID); ok {
		for range n {
			rows = append(rows, BoardRowInput{ID: uuid.New(), CapacityTE: te})
		}
	} else {
		if len(in.Rows) > MaxBoardRows {
			errs = append(errs, apperr.Field("body.rows", "validation.too_many", "too many rows").With("max", MaxBoardRows))
		}
		for i, r := range in.Rows {
			if f := checkCapacity(fmt.Sprintf("body.rows[%d].capacityTe", i), r.CapacityTE); f != nil {
				errs = append(errs, *f)
			}
			rows = append(rows, BoardRowInput{ID: uuid.New(), CapacityTE: roundTE(r.CapacityTE)})
		}
	}
	if len(errs) > 0 {
		return Plan{}, apperr.Validation(errs...)
	}
	prepared, err := s.prepareContentHooksIDs(ctx, versionID, ids)
	if err != nil {
		return Plan{}, err
	}
	var id uuid.UUID
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		id, err = q.CreateBoard(ctx, store.CreateBoardParams{
			TenantID: ref.TenantID, VersionID: versionID, Name: name, EnclosureVariantID: in.EnclosureVariantID,
		})
		if err := mapNameErr(err, name); err != nil {
			return err
		}
		if err := writeBoard(ctx, q, ref.TenantID, id, rows, nil); err != nil {
			return err
		}
		return s.runContentHooks(ctx, tx, ref, prepared)
	})
	if err != nil {
		return Plan{}, err
	}
	return s.detail(ctx, actor, id)
}

func checkCapacity(loc string, v float64) *apperr.FieldError {
	if !oneDecimal(v) || v <= 0 || v > MaxRowTE {
		f := apperr.Field(loc, "board.capacity_invalid", "the capacity must be above 0, at most 999.9, one decimal").With("max", MaxRowTE)
		return &f
	}
	return nil
}

// ---------------------------------------------------------------- read

type storedBoard struct {
	ref     projects.VersionRef
	plan    store.GetPlanRow
	rows    []BoardRowInput
	modules []BoardModule
}

func (s *Service) storedBoard(ctx context.Context, actor auth.Actor, id uuid.UUID) (storedBoard, error) {
	var st storedBoard
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if st.ref, err = s.readPlanVersion(ctx, actor, tx, q, id); err != nil {
			return err
		}
		if st.plan, err = q.GetPlan(ctx, id); err != nil {
			return notFound(err)
		}
		if st.plan.Kind != KindBoard {
			return errWrongKind(KindBoard)
		}
		st.rows, st.modules, err = readBoard(ctx, q, id)
		return err
	})
	return st, err
}

func readBoard(ctx context.Context, q *store.Queries, id uuid.UUID) ([]BoardRowInput, []BoardModule, error) {
	rrows, err := q.ListBoardRows(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	mrows, err := q.ListBoardModules(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]BoardRowInput, len(rrows))
	for i, r := range rrows {
		rows[i] = BoardRowInput{ID: r.ID, CapacityTE: r.CapacityTe}
	}
	modules := make([]BoardModule, len(mrows))
	for i, m := range mrows {
		modules[i] = BoardModule{
			BoardModuleInput: BoardModuleInput{
				ID: m.ID, RowID: m.RowID, OffsetTE: m.OffsetTe, VariantID: m.VariantID, Label: m.Label, Existing: m.Existing,
				AddonVariantIDs: m.AddonVariantIds, InstanceValues: m.InstanceValues,
			},
			CatalogVariantID: m.CatalogVariantID,
		}
		if modules[i].AddonVariantIDs == nil {
			modules[i].AddonVariantIDs = []uuid.UUID{}
		}
		if modules[i].InstanceValues == nil {
			modules[i].InstanceValues = attrschema.Values{}
		}
	}
	return rows, modules, nil
}

// writeBoard replaces the stored rows and modules (modules first: they
// reference their row).
func writeBoard(ctx context.Context, q *store.Queries, tenantID, planID uuid.UUID, rows []BoardRowInput, modules []BoardModule) error {
	if err := q.DeleteBoardModules(ctx, planID); err != nil {
		return err
	}
	if err := q.DeleteBoardRows(ctx, planID); err != nil {
		return err
	}
	if len(rows) > 0 {
		type rowRow struct {
			ID         uuid.UUID `json:"id"`
			CapacityTE float64   `json:"capacity_te"`
			Position   int       `json:"position"`
		}
		data := make([]rowRow, len(rows))
		for i, r := range rows {
			data[i] = rowRow{r.ID, r.CapacityTE, i + 1}
		}
		b, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if err := q.InsertBoardRows(ctx, store.InsertBoardRowsParams{TenantID: tenantID, PlanID: planID, Rows: b}); err != nil {
			return err
		}
	}
	if len(modules) > 0 {
		type moduleRow struct {
			ID              uuid.UUID         `json:"id"`
			RowID           uuid.UUID         `json:"row_id"`
			OffsetTE        float64           `json:"offset_te"`
			VariantID       *uuid.UUID        `json:"variant_id"`
			CatalogVariant  *uuid.UUID        `json:"catalog_variant_id"`
			Label           string            `json:"label"`
			Existing        bool              `json:"existing"`
			AddonVariantIDs []uuid.UUID       `json:"addon_variant_ids"`
			InstanceValues  attrschema.Values `json:"instance_values"`
			Position        int               `json:"position"`
		}
		data := make([]moduleRow, len(modules))
		for i, m := range modules {
			data[i] = moduleRow{
				ID: m.ID, RowID: m.RowID, OffsetTE: m.OffsetTE, VariantID: m.VariantID, CatalogVariant: m.CatalogVariantID,
				Label: m.Label, Existing: m.Existing, AddonVariantIDs: m.AddonVariantIDs, InstanceValues: m.InstanceValues,
				Position: i + 1,
			}
			if data[i].AddonVariantIDs == nil {
				data[i].AddonVariantIDs = []uuid.UUID{}
			}
			if data[i].InstanceValues == nil {
				data[i].InstanceValues = attrschema.Values{}
			}
		}
		b, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if err := q.InsertBoardModules(ctx, store.InsertBoardModulesParams{TenantID: tenantID, PlanID: planID, Rows: b}); err != nil {
			return err
		}
	}
	return nil
}

// BoardContent returns a board's rows and modules with the capability
// summaries and warnings.
func (s *Service) BoardContent(ctx context.Context, id uuid.UUID) (BoardContent, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return BoardContent{}, err
	}
	st, err := s.storedBoard(ctx, actor, id)
	if err != nil {
		return BoardContent{}, err
	}
	cat, err := s.boardCatalog(ctx, boardVariantIDs(st.plan.EnclosureVariantID, st.modules, false))
	if err != nil {
		return BoardContent{}, err
	}
	return s.boardOf(st.ref, st.plan, st.rows, st.modules, cat), nil
}

// boardVariantIDs lists the variants a board uses: the enclosure and the
// modules' variants (with their chosen add-ons when addons).
func boardVariantIDs(enclosure *uuid.UUID, modules []BoardModule, addons bool) []uuid.UUID {
	var ids []uuid.UUID
	if enclosure != nil {
		ids = append(ids, *enclosure)
	}
	for _, m := range modules {
		if m.VariantID != nil {
			ids = append(ids, *m.VariantID)
		}
		if addons {
			ids = append(ids, m.AddonVariantIDs...)
		}
	}
	return ids
}

// boardOf builds the response of a board's content.
func (s *Service) boardOf(ref projects.VersionRef, plan store.GetPlanRow, rows []BoardRowInput, modules []BoardModule, cat boardCatalog) BoardContent {
	out := BoardContent{
		PlanID: plan.ID, ContentUpdatedAt: plan.ContentUpdatedAt, EnclosureVariantID: plan.EnclosureVariantID,
		Rows: []BoardRow{}, Modules: []BoardModule{}, Capabilities: map[string]capabilities.Capabilities{}, Warnings: []BoardWarning{},
	}
	_, _, out.RowsFromEnclosure = cat.enclosureSize(plan.EnclosureVariantID)
	warn := func(module *uuid.UUID, code BoardWarningCode, addon *uuid.UUID) {
		out.Warnings = append(out.Warnings, BoardWarning{ModuleID: module, Code: code, AddonVariantID: addon})
	}
	// The enclosure.
	if plan.EnclosureCatalogVariantID != nil {
		if plan.EnclosureVariantID == nil {
			warn(nil, BoardWarningCode(WarnVariantDeleted), nil)
		} else {
			for _, w := range availabilityWarnings(ref, cat.variants, uuid.Nil, plan.EnclosureVariantID, nil) {
				warn(nil, BoardWarningCode(w.Code), w.AddonVariantID)
			}
			if !out.RowsFromEnclosure {
				warn(nil, WarnEnclosureSizeUnknown, nil)
			}
		}
	}
	used := map[uuid.UUID]float64{}
	ends := map[uuid.UUID][]BoardModule{}
	for _, m := range modules {
		id := m.ID
		w, known := cat.width(m.VariantID)
		m.WidthTE = w
		if m.VariantID != nil && !known {
			warn(&id, WarnModuleWidthUnknown, nil)
		}
		if m.VariantID != nil {
			if cp, ok := cat.caps[*m.VariantID]; ok && cp.Mounting == string(capabilities.MountingFloorplan) {
				warn(&id, WarnModuleMountingFloorplan, nil)
			}
		}
		for _, pw := range availabilityWarnings(ref, cat.variants, m.ID, m.VariantID, m.AddonVariantIDs) {
			warn(&id, BoardWarningCode(pw.Code), pw.AddonVariantID)
		}
		used[m.RowID] += w
		ends[m.RowID] = append(ends[m.RowID], m)
		out.UsedTE += w
		out.Modules = append(out.Modules, m)
	}
	capacity := map[uuid.UUID]float64{}
	for _, r := range rows {
		capacity[r.ID] = r.CapacityTE
		out.Rows = append(out.Rows, BoardRow{ID: r.ID, CapacityTE: r.CapacityTE, UsedTE: roundTE(used[r.ID])})
		out.CapacityTE += r.CapacityTE
	}
	for _, m := range out.Modules {
		if m.OffsetTE+m.WidthTE > capacity[m.RowID]+teEpsilon {
			id := m.ID
			warn(&id, WarnRowOverflow, nil)
		}
	}
	out.CapacityTE, out.UsedTE = roundTE(out.CapacityTE), roundTE(out.UsedTE)
	for id, c := range cat.caps {
		out.Capabilities[id.String()] = c
	}
	return out
}

// availabilityWarnings are the D54 warnings of one variant with its chosen
// add-ons (as for placements).
func availabilityWarnings(ref projects.VersionRef, variants map[uuid.UUID]products.PlacementVariant, itemID uuid.UUID, variantID *uuid.UUID, addons []uuid.UUID) []PlanWarning {
	if variantID == nil {
		return []PlanWarning{{PlacementID: itemID, Code: WarnVariantDeleted}}
	}
	return placementWarnings(ref, variants, PlanPlacement{PlanPlacementInput: PlanPlacementInput{ID: itemID, VariantID: variantID, AddonVariantIDs: addons}})
}

// ---------------------------------------------------------------- save

// SaveBoard replaces a board's content (enclosure, rows, modules) as a whole
// in one transaction; same lock and stale rules as SaveContent.
func (s *Service) SaveBoard(ctx context.Context, id uuid.UUID, in BoardContentInput) (BoardContent, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return BoardContent{}, err
	}
	st, err := s.storedBoard(ctx, actor, id)
	if err != nil {
		return BoardContent{}, err
	}
	if !st.ref.Writable() {
		return BoardContent{}, errReadOnly()
	}
	if err := s.requireLock(actor, st.plan.LockUserID, st.plan.LockExpiresAt); err != nil {
		return BoardContent{}, err
	}
	if !st.plan.ContentUpdatedAt.Equal(in.ExpectedContentUpdatedAt) {
		return BoardContent{}, errStale()
	}
	ids := make([]uuid.UUID, 0, len(in.Modules)+1)
	if in.EnclosureVariantID != nil {
		ids = append(ids, *in.EnclosureVariantID)
	}
	for _, m := range in.Modules {
		if m.VariantID != nil {
			ids = append(ids, *m.VariantID)
		}
	}
	cat, err := s.boardCatalog(ctx, ids)
	if err != nil {
		return BoardContent{}, err
	}
	rows, modules, err := validateBoard(st, cat, in)
	if err != nil {
		return BoardContent{}, err
	}
	var enclosureCatalog *uuid.UUID
	if in.EnclosureVariantID != nil {
		enclosureCatalog = in.EnclosureVariantID
	}
	prepared, err := s.prepareContentHooksIDs(ctx, st.plan.VersionID, boardVariantIDs(in.EnclosureVariantID, modules, true))
	if err != nil {
		return BoardContent{}, err
	}
	var row store.GetPlanRow
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, st.plan.VersionID, false)
		if err != nil {
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
		if err := writeBoard(ctx, q, locked.TenantID, id, rows, modules); err != nil {
			return err
		}
		if err := q.SetEnclosure(ctx, store.SetEnclosureParams{ID: id, EnclosureVariantID: in.EnclosureVariantID, EnclosureCatalogVariantID: enclosureCatalog}); err != nil {
			return err
		}
		if err := s.runContentHooks(ctx, tx, ref, prepared); err != nil {
			return err
		}
		if _, err := q.TouchContent(ctx, store.TouchContentParams{ID: id}); err != nil {
			return err
		}
		row, err = q.GetPlan(ctx, id)
		return err
	})
	if err != nil {
		return BoardContent{}, err
	}
	return s.boardOf(st.ref, row, rows, modules, cat), nil
}

// validateBoard checks and normalises a board's content (field errors at
// body.rows[i].… and body.modules[i].…). With an enclosure of known size the
// rows are fitted to it (D357): the first enclosureRows rows sent keep their
// ids and get its TE per row, missing rows are added, modules of rows beyond
// are moved to the end of the last row (row_overflow then warns).
func validateBoard(st storedBoard, cat boardCatalog, in BoardContentInput) ([]BoardRowInput, []BoardModule, error) {
	var errs []apperr.FieldError
	add := func(loc, code, detail string, params ...any) {
		f := apperr.Field(loc, code, detail)
		for i := 0; i+1 < len(params); i += 2 {
			f = f.With(params[i].(string), params[i+1])
		}
		errs = append(errs, f)
	}
	if len(in.Rows) > MaxBoardRows {
		add("body.rows", "validation.too_many", "too many rows", "max", MaxBoardRows)
	}
	if len(in.Modules) > MaxBoardModules {
		add("body.modules", "validation.too_many", "too many modules", "max", MaxBoardModules)
	}
	if len(errs) > 0 {
		return nil, nil, apperr.Validation(errs...)
	}
	if in.EnclosureVariantID != nil {
		_, ok := cat.variants[*in.EnclosureVariantID]
		unchanged := st.plan.EnclosureVariantID != nil && *st.plan.EnclosureVariantID == *in.EnclosureVariantID
		if !ok && !unchanged {
			add("body.enclosureVariantId", "board.enclosure_not_found", "no such variant")
		}
	}
	enclosureRows, enclosureTE, fromEnclosure := cat.enclosureSize(in.EnclosureVariantID)

	rows := make([]BoardRowInput, len(in.Rows))
	rowIndex := map[uuid.UUID]int{}
	for i, r := range in.Rows {
		loc := fmt.Sprintf("body.rows[%d]", i)
		if _, dup := rowIndex[r.ID]; dup || r.ID == uuid.Nil {
			add(loc+".id", "plan.duplicate_id", "the id is used twice")
		}
		rowIndex[r.ID] = i
		if fromEnclosure {
			r.CapacityTE = enclosureTE
		} else if f := checkCapacity(loc+".capacityTe", r.CapacityTE); f != nil {
			errs = append(errs, *f)
		}
		r.CapacityTE = roundTE(r.CapacityTE)
		rows[i] = r
	}

	stored := make(map[uuid.UUID]BoardModule, len(st.modules))
	for _, m := range st.modules {
		stored[m.ID] = m
	}
	modules := make([]BoardModule, len(in.Modules))
	seen := map[uuid.UUID]bool{}
	for i, m := range in.Modules {
		loc := fmt.Sprintf("body.modules[%d]", i)
		if seen[m.ID] || m.ID == uuid.Nil {
			add(loc+".id", "plan.duplicate_id", "the id is used twice")
		}
		seen[m.ID] = true
		prev, wasStored := stored[m.ID]
		if _, ok := rowIndex[m.RowID]; !ok {
			add(loc+".rowId", "board.row_not_found", "no such row in this content")
		}
		if !oneDecimal(m.OffsetTE) || m.OffsetTE < 0 || m.OffsetTE > MaxRowTE {
			add(loc+".offsetTe", "board.offset_invalid", "the offset must be 0-999.9 with one decimal", "max", MaxRowTE)
		}
		m.OffsetTE = roundTE(m.OffsetTE)
		m.Label = strings.TrimSpace(m.Label)
		if f := checkText(loc+".label", m.Label, MaxLabelLength, false); f != nil {
			errs = append(errs, *f)
		}
		var v *products.PlacementVariant
		if m.VariantID == nil {
			if !wasStored || prev.VariantID != nil {
				add(loc+".variantId", "plan.variant_required", "choose a product")
			}
		} else if found, ok := cat.variants[*m.VariantID]; ok {
			v = &found
		} else if wasStored && prev.VariantID == nil {
			m.VariantID = nil
		} else {
			add(loc+".variantId", "plan.variant_not_found", "no such variant")
		}
		var prevAddons []uuid.UUID
		var prevValues attrschema.Values
		if wasStored && prev.VariantID != nil && m.VariantID != nil && *prev.VariantID == *m.VariantID {
			prevAddons, prevValues = prev.AddonVariantIDs, prev.InstanceValues
		}
		if v == nil {
			m.AddonVariantIDs, m.InstanceValues = prevAddons, prevValues
		} else {
			m.AddonVariantIDs, errs = checkAddons(loc+".addonVariantIds", *v, m.AddonVariantIDs, prevAddons, errs)
			var valueErrs []apperr.FieldError
			m.InstanceValues, valueErrs = instanceValues(v.InstanceAttributes, m.InstanceValues, prevValues, loc+".instanceValues")
			errs = append(errs, valueErrs...)
		}
		if m.AddonVariantIDs == nil {
			m.AddonVariantIDs = []uuid.UUID{}
		}
		if m.InstanceValues == nil {
			m.InstanceValues = attrschema.Values{}
		}
		modules[i] = BoardModule{BoardModuleInput: m, CatalogVariantID: m.VariantID}
		if m.VariantID == nil && wasStored {
			modules[i].CatalogVariantID = prev.CatalogVariantID
		}
		modules[i].WidthTE, _ = cat.width(m.VariantID)
	}
	if len(errs) > 0 {
		return nil, nil, apperr.Validation(errs...)
	}
	// No overlap within a row: [offset, offset + width).
	for i, a := range modules {
		for j := range i {
			b := modules[j]
			if a.RowID == b.RowID && a.OffsetTE < b.OffsetTE+b.WidthTE-teEpsilon && b.OffsetTE < a.OffsetTE+a.WidthTE-teEpsilon {
				add(fmt.Sprintf("body.modules[%d].offsetTe", i), "board.overlap", "the module overlaps another one in the row",
					"moduleId", b.ID.String())
				break
			}
		}
	}
	if len(errs) > 0 {
		return nil, nil, apperr.Validation(errs...)
	}
	if fromEnclosure {
		rows, modules = fitRows(rows, modules, enclosureRows, enclosureTE)
	}
	return rows, modules, nil
}

// fitRows fits rows to an enclosure of n rows of te each (D357).
func fitRows(rows []BoardRowInput, modules []BoardModule, n int, te float64) ([]BoardRowInput, []BoardModule) {
	for len(rows) < n {
		rows = append(rows, BoardRowInput{ID: uuid.New()})
	}
	kept := rows[:n]
	for i := range kept {
		kept[i].CapacityTE = te
	}
	if len(rows) == n {
		return kept, modules
	}
	last := kept[n-1].ID
	keep := map[uuid.UUID]bool{}
	for _, r := range kept {
		keep[r.ID] = true
	}
	end := 0.0
	for _, m := range modules {
		if m.RowID == last {
			end = math.Max(end, m.OffsetTE+m.WidthTE)
		}
	}
	for i := range modules {
		if !keep[modules[i].RowID] {
			modules[i].RowID = last
			modules[i].OffsetTE = roundTE(end)
			end = modules[i].OffsetTE + modules[i].WidthTE
		}
	}
	return kept, modules
}

// ---------------------------------------------------------------- plan cards

// usedTE sums the module widths of the boards of rows (plan cards).
func (s *Service) usedTE(ctx context.Context, rows []store.BoardModuleVariantsRow) (map[uuid.UUID]float64, error) {
	out := map[uuid.UUID]float64{}
	if len(rows) == 0 {
		return out, nil
	}
	var ids []uuid.UUID
	for _, r := range rows {
		if r.VariantID != nil {
			ids = append(ids, *r.VariantID)
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	ids = slices.Compact(ids)
	caps := map[uuid.UUID]capabilities.Capabilities{}
	if len(ids) > 0 {
		var err error
		if caps, err = s.products.Capabilities(ctx, ids); err != nil {
			return nil, err
		}
	}
	cat := boardCatalog{caps: caps}
	for _, r := range rows {
		w, _ := cat.width(r.VariantID)
		out[r.PlanID] += w
	}
	for k, v := range out {
		out[k] = roundTE(v)
	}
	return out, nil
}

func errWrongKind(want string) *apperr.Error {
	return apperr.New(http.StatusConflict, "plan.wrong_kind", "this is not a plan of that kind").With("kind", want)
}
