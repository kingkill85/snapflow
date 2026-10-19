package wiring_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Another tenant gets 404 from every endpoint of a version.
func TestCrossTenantNotFound(t *testing.T) {
	w := setup(t)
	api := w.api
	resp := api.Post(w.url("/connections"), w.user.Cookie, w.connect(1, 1))
	want(t, resp, http.StatusCreated, "")
	id := decode[wiring.ConnectionResult](t, resp).Connection.ID
	other := api.NewUser(api.NewTenant("Other"), auth.RoleUser).Cookie
	want(t, api.Get(w.url("/wiring"), other), http.StatusNotFound, "")
	want(t, api.Get(w.url("/checks"), other), http.StatusNotFound, "")
	want(t, api.Post(w.url("/connections/candidates"), other, map[string]any{"needPlanId": w.floor, "needId": w.need}), http.StatusNotFound, "")
	want(t, api.Post(w.url("/auto-connect/preview"), other, map[string]any{"scope": "all"}), http.StatusNotFound, "")
	want(t, api.Post(w.url("/auto-connect/apply"), other, map[string]any{"scope": "all", "expectedChecksum": "x"}), http.StatusNotFound, "")
	want(t, api.Delete(w.url("/auto-connect/"+uuid.New().String()), other), http.StatusNotFound, "")
	want(t, api.Put(w.url("/connections/"+id.String()), other, map[string]any{"units": 1, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 2}), http.StatusNotFound, "")
	want(t, api.Delete(w.url("/connections/"+id.String()), other), http.StatusNotFound, "")
	want(t, api.Post(w.url("/connections/disconnect"), other, map[string]any{"needPlanId": w.floor, "needId": w.need}), http.StatusNotFound, "")
}

// A completed project refuses every change, also the undo of a batch and
// moving a connection; reads keep working.
func TestReadOnlyUndoAndUpdate(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	prev := decode[wiring.AutoConnectPreview](t, api.Post(w.url("/auto-connect/preview"), cookie, map[string]any{"scope": "all"}))
	resp := api.Post(w.url("/auto-connect/apply"), cookie, map[string]any{"scope": "all", "expectedChecksum": prev.Checksum})
	want(t, resp, http.StatusOK, "")
	res := decode[wiring.AutoConnectResult](t, resp)
	if res.BatchID == nil || len(res.Connections) == 0 {
		t.Fatalf("apply %+v", res)
	}
	p := decode[struct {
		Name      string
		UpdatedAt time.Time
	}](t, api.Get("/api/projects/"+w.project.String(), cookie))
	want(t, api.Put("/api/projects/"+w.project.String(), cookie, map[string]any{
		"name": p.Name, "status": "completed", "expectedUpdatedAt": p.UpdatedAt}), http.StatusOK, "")
	want(t, api.Delete(w.url("/auto-connect/"+res.BatchID.String()), cookie), http.StatusConflict, "project.read_only")
	want(t, api.Put(w.url("/connections/"+res.Connections[0].ID.String()), cookie, map[string]any{"units": 1, "targetPlanId": w.board,
		"targetItemId": w.module, "outputKindId": w.dimmerKind, "channelNo": 2}), http.StatusConflict, "project.read_only")
	want(t, api.Post(w.url("/connections/disconnect"), cookie, map[string]any{"targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 1}), http.StatusConflict, "project.read_only")
	want(t, api.Get(w.url("/wiring"), cookie), http.StatusOK, "")
	want(t, api.Post(w.url("/connections/candidates"), cookie, map[string]any{"needPlanId": w.floor, "needId": w.need}), http.StatusOK, "")
}

// A need or target of another version of the project is not found.
func TestConnectAcrossVersions(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie
	resp := api.Post("/api/projects/"+w.project.String()+"/versions", cookie, map[string]any{"name": "Copy", "sourceVersionId": w.version})
	want(t, resp, http.StatusCreated, "")
	copyID := decode[struct{ ID uuid.UUID }](t, resp).ID
	view := decode[wiring.Wiring](t, api.Get("/api/versions/"+copyID.String()+"/wiring", cookie))
	if len(view.Items) != 1 || len(view.Needs) != 1 {
		t.Fatalf("copy %+v", view)
	}
	// The copy's board in this version.
	body := w.connect(1, 1)
	body["targetPlanId"] = view.Items[0].PlanID
	want(t, api.Post(w.url("/connections"), cookie, body), http.StatusUnprocessableEntity, "connection.target_not_found")
	// This version's need in the copy.
	want(t, api.Post("/api/versions/"+copyID.String()+"/connections", cookie, w.connect(1, 1)), http.StatusUnprocessableEntity, "connection.need_not_found")
}

// Alternative channels: moving a connection onto a pair whose base channel
// is in use is refused; the pair keeps its base channels by identity.
func TestPairConflict(t *testing.T) {
	w := setup(t, true)
	api, cookie := w.api, w.user.Cookie
	view := decode[wiring.Wiring](t, api.Get(w.url("/wiring"), cookie))
	if chs := view.Items[0].Channels; len(chs) != 3 || !chs[2].Alternative || chs[2].BaseFrom != 1 || chs[2].BaseTo != 2 {
		t.Fatalf("channels %+v", chs)
	}
	resp := api.Post(w.url("/connections"), cookie, w.connect(1, 1)) // dimmer 1
	want(t, resp, http.StatusCreated, "")
	resp = api.Post(w.url("/connections"), cookie, w.connect(1, 2)) // dimmer 2
	want(t, resp, http.StatusCreated, "")
	second := decode[wiring.ConnectionResult](t, resp).Connection.ID
	want(t, api.Put(w.url("/connections/"+second.String()), cookie, map[string]any{"units": 1, "targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.pairKind, "channelNo": 1}), http.StatusUnprocessableEntity, "connection.channel_conflict")
	// Disconnect dimmer 1, then the pair takes the unit; dimmer 1 shows blocked.
	want(t, api.Post(w.url("/connections/disconnect"), cookie, map[string]any{"targetPlanId": w.board, "targetItemId": w.module,
		"outputKindId": w.dimmerKind, "channelNo": 1}), http.StatusOK, "")
	want(t, api.Delete(w.url("/connections/"+second.String()), cookie), http.StatusNoContent, "")
	pair := w.connect(1, 1)
	pair["outputKindId"] = w.pairKind
	want(t, api.Post(w.url("/connections"), cookie, pair), http.StatusCreated, "")
	view = decode[wiring.Wiring](t, api.Get(w.url("/wiring"), cookie))
	if chs := view.Items[0].Channels; !chs[0].Blocked || len(chs[2].ConnectionIDs) != 1 {
		t.Fatalf("channels %+v", chs)
	}
	if c := view.Connections[0]; c.OutputKindID != w.pairKind || c.ChannelNo != 1 {
		t.Fatalf("connection %+v", c)
	}
}
