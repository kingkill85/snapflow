package plans_test

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

type boardWorld struct {
	api     *apptest.API
	c       apptest.BoardCatalog
	cookie  string
	user    apptest.Session
	project project
	version uuid.UUID
}

func newBoardWorld(t *testing.T) boardWorld {
	api := apptest.New(t)
	c := api.NewBoardCatalog()
	user := api.NewUser(api.NewTenant("Acme"), auth.RoleUser)
	p := newProject(t, api, user.Cookie, c.KNX.String(), c.Zigbee.String())
	return boardWorld{api: api, c: c, cookie: user.Cookie, user: user, project: p, version: p.Versions[0].ID}
}

// newBoard adds a locked board with the body given.
func (w boardWorld) newBoard(t *testing.T, body map[string]any) plans.BoardContent {
	t.Helper()
	resp := w.api.Post("/api/versions/"+w.version.String()+"/boards", w.cookie, body)
	wantCode(t, resp, http.StatusCreated, "")
	id := decode[plans.Plan](t, resp).ID
	lock(t, w.api, w.cookie, id)
	return getBoard(t, w.api, w.cookie, id)
}

// setWidth changes a variant's product rail width in the catalog.
func (w boardWorld) setWidth(t *testing.T, variant uuid.UUID, width float64) {
	t.Helper()
	_, err := w.api.DB.Exec(context.Background(),
		`UPDATE products SET attributes = attributes || jsonb_build_object('width_te', $2::float8)
		 WHERE id = (SELECT product_id FROM product_variants WHERE id = $1)`, variant, width)
	if err != nil {
		t.Fatal(err)
	}
}

func (w boardWorld) bomQty(t *testing.T, plan uuid.UUID) map[uuid.UUID]int64 {
	t.Helper()
	bm := decode[bom.BOM](t, w.api.Get("/api/versions/"+w.version.String()+"/bom", w.cookie))
	qty := map[uuid.UUID]int64{}
	for _, l := range bm.Lines {
		if l.VariantID != nil {
			qty[*l.VariantID] = l.Quantities.Plans[plan.String()]
		}
	}
	return qty
}

// D374, D376: overlap after a catalog width change is a warning; only a
// moved or new module must not overlap. Half TE and decimal widths touch.
func TestBoardOverlapRules(t *testing.T) {
	w := newBoardWorld(t)
	b := w.newBoard(t, map[string]any{"name": "B", "rows": []any{map[string]any{"capacityTe": 24}}})
	r := b.Rows[0].ID
	a, p1, p2 := uuid.New(), uuid.New(), uuid.New()

	// Half TE: PSU (2) at 4.5 and 6.5 touch the actuator (4) at 0.5.
	resp := saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{module(a, r, w.c.Actuator, 0.5), module(p1, r, w.c.PSU, 4.5), module(p2, r, w.c.PSU, 6.5)})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{module(a, r, w.c.Actuator, 0.5), module(p1, r, w.c.PSU, 4.5), module(p2, r, w.c.PSU, 6)})
	wantCode(t, resp, http.StatusUnprocessableEntity, "")

	// The actuator grows to 5 TE in the catalog: the stored modules overlap.
	w.setWidth(t, w.c.Actuator, 5)
	b = getBoard(t, w.api, w.cookie, b.PlanID)
	if fs := planFindings(t, w.api, w.cookie, b.PlanID); !slices.Contains(codesOf(fs, p1), "module_overlap") || slices.Contains(codesOf(fs, p2), "module_overlap") {
		t.Fatalf("overlap warning: %+v", fs)
	}
	// Saving unchanged (or a label change) keeps it.
	ma := module(a, r, w.c.Actuator, 0.5)
	ma["label"] = "Main"
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{ma, module(p1, r, w.c.PSU, 4.5), module(p2, r, w.c.PSU, 6.5)})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	// Moving one of the two, still overlapping, is refused.
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{ma, module(p1, r, w.c.PSU, 5), module(p2, r, w.c.PSU, 6.5)})
	wantCode(t, resp, http.StatusUnprocessableEntity, "")
	if f := fields(t, resp); !slices.Contains(f, "body.modules[2].offsetTe board.overlap") {
		t.Errorf("moved overlap: %v", f)
	}
	// Moving it clear is fine.
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{ma, module(p1, r, w.c.PSU, 8.5), module(p2, r, w.c.PSU, 6.5)})
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)

	// 1.24 TE is 1.2 TE (one decimal, D376): modules at 12, 13.2 and 14.4
	// touch; at 14.3 it overlaps 13.2-14.4.
	w.setWidth(t, w.c.NoWidth, 1.24)
	n1, n2, n3 := uuid.New(), uuid.New(), uuid.New()
	base := []any{ma, module(p1, r, w.c.PSU, 8.5), module(p2, r, w.c.PSU, 6.5)}
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), append(slices.Clone(base),
		module(n1, r, w.c.NoWidth, 12), module(n2, r, w.c.NoWidth, 13.2), module(n3, r, w.c.NoWidth, 14.4)))
	wantCode(t, resp, http.StatusOK, "")
	b = decode[plans.BoardContent](t, resp)
	if b.Modules[3].WidthTE != 1.2 || b.Rows[0].UsedTE != 5+2+2+3.6 {
		t.Errorf("width 1.24: %+v %+v", b.Modules[3], b.Rows[0])
	}
	resp = saveBoard(w.api, w.cookie, b, nil, rowsOf(b), append(slices.Clone(base),
		module(n1, r, w.c.NoWidth, 12), module(n2, r, w.c.NoWidth, 13.2), module(n3, r, w.c.NoWidth, 14.3)))
	wantCode(t, resp, http.StatusUnprocessableEntity, "")
	// The plan card sketch.
	card := getPlan(t, w.api, w.cookie, b.PlanID)
	if s := card.Board.Sketch; len(s.Rows) != 1 || s.Rows[0].CapacityTE != 24 || len(s.Modules) != 6 || s.Modules[0].OffsetTE != 0.5 ||
		s.Modules[0].WidthTE != 5 || s.Modules[3].WidthTE != 1.2 || s.Modules[0].Row != 0 {
		t.Errorf("sketch: %+v", card.Board.Sketch)
	}
	list := decode[[]plans.Plan](t, w.api.Get("/api/versions/"+w.version.String()+"/plans", w.cookie))
	if len(list) != 1 || len(list[0].Board.Sketch.Modules) != 6 {
		t.Errorf("list sketch: %+v", list)
	}
}

// D375: an existing enclosure is not in the BOM; a deleted enclosure stays
// until removed explicitly; deleted module variants keep their BOM line;
// module add-ons count.
func TestBoardEnclosureAndDeletedVariants(t *testing.T) {
	w := newBoardWorld(t)
	admin := w.api.Admin.Cookie
	gen := newCatalog(t, w.api, "gen")
	p := decode[struct {
		Name      string
		UpdatedAt string
	}](t, w.api.Get("/api/projects/"+w.project.ID.String(), w.cookie))
	wantCode(t, w.api.Put("/api/projects/"+w.project.ID.String(), w.cookie, map[string]any{"name": p.Name, "status": "active",
		"expectedUpdatedAt": p.UpdatedAt, "productTypeIds": []any{w.c.KNX, w.c.Zigbee, gen.TypeID}}), http.StatusOK, "")

	b := w.newBoard(t, map[string]any{"name": "B", "enclosureVariantId": w.c.Enclosure})
	a, g := uuid.New(), uuid.New()
	mg := module(g, b.Rows[1].ID, uuid.MustParse(gen.Main), 0)
	mg["addonVariantIds"] = []any{gen.Opt, gen.Req}
	body := func(b plans.BoardContent, enclosure *uuid.UUID, extra map[string]any, actVariant any) map[string]any {
		ma := module(a, b.Rows[0].ID, w.c.Actuator, 0)
		ma["variantId"] = actVariant
		out := map[string]any{"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": enclosure, "rows": rowsOf(b),
			"modules": []any{ma, mg}}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	put := func(body map[string]any) plans.BoardContent {
		t.Helper()
		resp := w.api.Put("/api/plans/"+b.PlanID.String()+"/board", w.cookie, body)
		wantCode(t, resp, http.StatusOK, "")
		return decode[plans.BoardContent](t, resp)
	}
	b = put(body(b, &w.c.Enclosure, nil, w.c.Actuator))
	q := w.bomQty(t, b.PlanID)
	if q[w.c.Enclosure] != 1 || q[w.c.Actuator] != 1 || q[uuid.MustParse(gen.Opt)] != 1 || q[uuid.MustParse(gen.Req)] != 1 {
		t.Errorf("bom: %v", q)
	}
	// An existing enclosure is left out of the BOM.
	b = put(body(b, &w.c.Enclosure, map[string]any{"enclosureExisting": true}, w.c.Actuator))
	if !b.EnclosureExisting || w.bomQty(t, b.PlanID)[w.c.Enclosure] != 0 {
		t.Errorf("existing enclosure: %v %v", b.EnclosureExisting, w.bomQty(t, b.PlanID))
	}
	b = put(body(b, &w.c.Enclosure, nil, w.c.Actuator))

	// Delete the enclosure and actuator variants from the catalog.
	for _, v := range []uuid.UUID{w.c.Enclosure, w.c.Actuator} {
		page := decode[struct {
			Items []struct{ ID, ProductID uuid.UUID }
		}](t, w.api.Get("/api/variants?limit=200", admin))
		var pid uuid.UUID
		for _, it := range page.Items {
			if it.ID == v {
				pid = it.ProductID
			}
		}
		wantCode(t, w.api.Delete("/api/products/"+pid.String()+"/variants/"+v.String(), admin), http.StatusNoContent, "")
	}
	b = getBoard(t, w.api, w.cookie, b.PlanID)
	fs := planFindings(t, w.api, w.cookie, b.PlanID)
	encWarn := slices.Contains(codesOf(fs, uuid.Nil), "variant_deleted")
	if !b.EnclosureDeleted || b.EnclosureVariantID != nil || !encWarn || !slices.Contains(codesOf(fs, a), "variant_deleted") {
		t.Fatalf("deleted: %+v", b)
	}
	// Saving with null keeps both (BOM lines from the snapshot).
	b = put(body(b, nil, nil, nil))
	q = w.bomQty(t, b.PlanID)
	if !b.EnclosureDeleted || q[w.c.Enclosure] != 1 || q[w.c.Actuator] != 1 {
		t.Errorf("kept: %v %v", b.EnclosureDeleted, q)
	}
	bm := decode[bom.BOM](t, w.api.Get("/api/versions/"+w.version.String()+"/bom", w.cookie))
	for _, l := range bm.Lines {
		if l.VariantID != nil && *l.VariantID == w.c.Actuator && (l.Snapshot == nil || l.Snapshot.ModelNumber != "ACT") {
			t.Errorf("snapshot of the deleted module variant: %+v", l)
		}
	}
	// removeEnclosure removes it.
	b = put(body(b, nil, map[string]any{"removeEnclosure": true}, nil))
	if b.EnclosureDeleted || w.bomQty(t, b.PlanID)[w.c.Enclosure] != 0 {
		t.Errorf("removed: %+v", b)
	}
}

// Row-level security on board_rows and board_modules: nothing foreign is
// read, and rows cannot be planted into another tenant.
func TestBoardRowLevelSecurity(t *testing.T) {
	w := newBoardWorld(t)
	ctx := t.Context()
	b := w.newBoard(t, map[string]any{"name": "B", "rows": []any{map[string]any{"capacityTe": 12}}})
	wantCode(t, saveBoard(w.api, w.cookie, b, nil, rowsOf(b), []any{module(uuid.New(), b.Rows[0].ID, w.c.PSU, 0)}), http.StatusOK, "")

	intruderTenant := w.api.NewTenant("Intruder")
	intruder := w.api.NewUser(intruderTenant, auth.RoleUser)
	tx, err := w.api.DB.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := database.SetScope(ctx, tx, auth.Actor{UserID: intruder.UserID, TenantID: intruderTenant, Role: auth.RoleUser}); err != nil {
		t.Fatal(err)
	}
	q := store.New(tx)
	if rows, err := q.ListBoardRows(ctx, b.PlanID); err != nil || len(rows) != 0 {
		t.Errorf("foreign rows: %v %v", rows, err)
	}
	if rows, err := q.ListBoardModules(ctx, b.PlanID); err != nil || len(rows) != 0 {
		t.Errorf("foreign modules: %v %v", rows, err)
	}
	if err := q.DeleteBoardModules(ctx, b.PlanID); err != nil {
		t.Fatal(err)
	}
	var pgErr *pgconn.PgError
	err = q.InsertBoardRows(ctx, store.InsertBoardRowsParams{TenantID: w.user.TenantID, PlanID: b.PlanID,
		Rows: []byte(`[{"id":"` + uuid.NewString() + `","capacity_te":5,"position":9}]`)})
	if !errors.As(err, &pgErr) || pgErr.Code != "42501" {
		t.Errorf("planted row: %v", err)
	}
	_ = tx.Rollback(ctx)
	// Nothing changed.
	if got := getBoard(t, w.api, w.cookie, b.PlanID); len(got.Modules) != 1 || len(got.Rows) != 1 {
		t.Errorf("after intruder: %+v", got)
	}
}
