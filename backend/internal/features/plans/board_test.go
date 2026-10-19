package plans_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

func module(id, rowID, variantID uuid.UUID, offset float64) map[string]any {
	return map[string]any{"id": id, "rowId": rowID, "offsetTe": offset, "variantId": variantID, "label": "", "existing": false,
		"addonVariantIds": []any{}, "instanceValues": map[string]any{}}
}

func saveBoard(api *apptest.API, cookie string, b plans.BoardContent, enclosure *uuid.UUID, rows []any, modules []any) *httptest.ResponseRecorder {
	return api.Put("/api/plans/"+b.PlanID.String()+"/board", cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": enclosure, "rows": rows, "modules": modules,
	})
}

func getBoard(t *testing.T, api *apptest.API, cookie string, id uuid.UUID) plans.BoardContent {
	t.Helper()
	resp := api.Get("/api/plans/"+id.String()+"/board", cookie)
	wantCode(t, resp, http.StatusOK, "")
	return decode[plans.BoardContent](t, resp)
}

func rowsOf(b plans.BoardContent) []any {
	out := []any{}
	for _, r := range b.Rows {
		out = append(out, map[string]any{"id": r.ID, "capacityTe": r.CapacityTE})
	}
	return out
}

func warningCodes(b plans.BoardContent, id uuid.UUID) []string {
	var out []string
	for _, w := range b.Warnings {
		if w.ModuleID != nil && *w.ModuleID == id {
			out = append(out, string(w.Code))
		}
	}
	return out
}

func TestBoards(t *testing.T) {
	api := apptest.New(t)
	c := api.NewBoardCatalog()
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.KNX.String(), c.Zigbee.String())
	version := p.Versions[0].ID

	// A board with an enclosure gets its rows (2 × 12 TE).
	resp := api.Post("/api/versions/"+version.String()+"/boards", user.Cookie, map[string]any{"name": "Main board", "enclosureVariantId": c.Enclosure})
	wantCode(t, resp, http.StatusCreated, "")
	board := decode[plans.Plan](t, resp)
	if board.Kind != plans.KindBoard || board.Image != nil || board.Board == nil || board.Board.CapacityTE != 24 ||
		board.Board.EnclosureVariantID == nil || *board.Board.EnclosureVariantID != c.Enclosure {
		t.Fatalf("board: %+v %+v", board, board.Board)
	}
	b := getBoard(t, api, user.Cookie, board.ID)
	if len(b.Rows) != 2 || b.Rows[0].CapacityTE != 12 || !b.RowsFromEnclosure {
		t.Fatalf("rows: %+v", b)
	}
	// Floorplan content endpoints refuse a board.
	wantCode(t, api.Get("/api/plans/"+board.ID.String()+"/content", user.Cookie), http.StatusConflict, "plan.wrong_kind")
	// Saving needs the lock.
	r1, r2 := b.Rows[0].ID, b.Rows[1].ID
	act, psu := uuid.New(), uuid.New()
	wantCode(t, saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{module(act, r1, c.Actuator, 0)}), http.StatusConflict, "plan.lock_required")
	lock(t, api, user.Cookie, board.ID)

	// Overlap is an error.
	resp = saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{module(act, r1, c.Actuator, 0), module(psu, r1, c.PSU, 3.5)})
	wantCode(t, resp, http.StatusUnprocessableEntity, "")
	if f := fields(t, resp); !slices.Contains(f, "body.modules[1].offsetTe board.overlap") {
		t.Errorf("overlap: %v", f)
	}
	// Bad row and offset.
	resp = saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{module(act, uuid.New(), c.Actuator, 0.25)})
	if f := fields(t, resp); !slices.Contains(f, "body.modules[0].rowId board.row_not_found") || !slices.Contains(f, "body.modules[0].offsetTe board.offset_invalid") {
		t.Errorf("row/offset: %v", f)
	}

	// Warnings: unknown width, floorplan product, overflow.
	nowidth, sensor, over := uuid.New(), uuid.New(), uuid.New()
	resp = saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{
		module(act, r1, c.Actuator, 0), module(psu, r1, c.PSU, 4),
		module(nowidth, r2, c.NoWidth, 0), module(sensor, r2, c.Sensor, 1), module(over, r2, c.Actuator, 10),
	})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	if !slices.Contains(warningCodes(b, nowidth), "module_width_unknown") || !slices.Contains(warningCodes(b, sensor), "module_mounting_floorplan") ||
		!slices.Contains(warningCodes(b, over), "row_overflow") || len(warningCodes(b, act)) != 0 {
		t.Errorf("warnings: %+v", b.Warnings)
	}
	if b.UsedTE != 12 || b.Rows[0].UsedTE != 6 || b.Rows[1].UsedTE != 6 || b.Modules[2].WidthTE != 1 {
		t.Errorf("TE: %v %+v", b.UsedTE, b.Rows)
	}
	if cp, ok := b.Capabilities[c.PSU.String()]; !ok || cp.BusCurrentSuppliedMa == nil || *cp.BusCurrentSuppliedMa != 640 {
		t.Errorf("capabilities: %+v", b.Capabilities)
	}
	if _, ok := b.Capabilities[c.Enclosure.String()]; !ok {
		t.Errorf("enclosure capabilities missing")
	}
	// Stale.
	old := b
	old.ContentUpdatedAt = old.ContentUpdatedAt.Add(-1)
	wantCode(t, saveBoard(api, user.Cookie, old, &c.Enclosure, rowsOf(b), []any{}), http.StatusConflict, "plan.stale")

	// The plan card counts modules and TE.
	card := getPlan(t, api, user.Cookie, board.ID)
	if card.Board == nil || card.Board.ModuleCount != 5 || card.Board.UsedTE != 12 {
		t.Errorf("card: %+v", card.Board)
	}

	// BOM: modules and the enclosure in the board's column; existing ones
	// are left out.
	bm := decode[bom.BOM](t, api.Get("/api/versions/"+version.String()+"/bom", user.Cookie))
	qty := map[uuid.UUID]int64{}
	for _, l := range bm.Lines {
		if l.VariantID != nil {
			qty[*l.VariantID] = l.Quantities.Plans[board.ID.String()]
		}
	}
	if qty[c.Actuator] != 2 || qty[c.PSU] != 1 || qty[c.Enclosure] != 1 || qty[c.Sensor] != 1 {
		t.Errorf("bom quantities: %v", qty)
	}

	// Without enclosure the rows are free; with a 3rd row and back to the
	// enclosure the module of row 3 moves to the end of row 2 (D357).
	r3 := uuid.New()
	rows := append(rowsOf(b), map[string]any{"id": r3, "capacityTe": 8})
	resp = saveBoard(api, user.Cookie, b, nil, rows, []any{module(act, r1, c.Actuator, 0), module(psu, r3, c.PSU, 0), module(over, r2, c.Actuator, 2)})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	if len(b.Rows) != 3 || b.RowsFromEnclosure || b.EnclosureVariantID != nil {
		t.Fatalf("free rows: %+v", b)
	}
	resp = saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{module(act, r1, c.Actuator, 0), module(psu, r3, c.PSU, 0), module(over, r2, c.Actuator, 2)})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	if len(b.Rows) != 2 || b.Modules[1].RowID != r2 || b.Modules[1].OffsetTE != 6 || b.Rows[1].CapacityTE != 12 {
		t.Errorf("fitted: %+v %+v", b.Rows, b.Modules)
	}

	// Another tenant does not see the board.
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser)
	wantCode(t, api.Get("/api/plans/"+board.ID.String()+"/board", other.Cookie), http.StatusNotFound, "")

	// Version copy keeps row and module ids.
	resp = api.Post("/api/projects/"+p.ID.String()+"/versions", user.Cookie, map[string]any{"name": "V2", "sourceVersionId": version})
	wantCode(t, resp, http.StatusCreated, "")
	target := decode[struct{ ID uuid.UUID }](t, resp).ID
	copied := decode[[]plans.Plan](t, api.Get("/api/versions/"+target.String()+"/plans", user.Cookie))
	cb := getBoard(t, api, user.Cookie, copied[0].ID)
	if copied[0].ID == board.ID || len(cb.Modules) != 3 || cb.Modules[0].ID != act || cb.Rows[0].ID != r1 ||
		cb.EnclosureVariantID == nil || *cb.EnclosureVariantID != c.Enclosure {
		t.Errorf("copy: %+v", cb)
	}

	// Read-only project: the save is refused.
	pr := decode[project](t, api.Get("/api/projects/"+p.ID.String(), user.Cookie))
	wantCode(t, api.Put("/api/projects/"+p.ID.String(), user.Cookie, map[string]any{
		"name": "House", "status": "completed", "expectedUpdatedAt": pr.UpdatedAt,
	}), http.StatusOK, "")
	wantCode(t, saveBoard(api, user.Cookie, b, &c.Enclosure, rowsOf(b), []any{}), http.StatusConflict, "project.read_only")
}
