package wiring_test

import (
	"net/http"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
)

func TestWiringViewAndCandidates(t *testing.T) {
	w := setup(t)
	api, cookie := w.api, w.user.Cookie

	view := decode[wiring.Wiring](t, api.Get(w.url("/wiring"), cookie))
	if len(view.Items) != 1 || len(view.Items[0].Channels) != 2 || view.Items[0].PlanKind != "board" || view.Items[0].ProductName == nil {
		t.Fatalf("items %+v", view.Items)
	}
	if len(view.Needs) != 1 || view.Needs[0].ZoneName != "Kitchen" || view.Needs[0].FunctionTypeKey != "light" || view.Needs[0].ConnectedUnits != 0 {
		t.Fatalf("needs %+v", view.Needs)
	}

	// Need mode: both dimmer channels take 2 of the 3 units (100 W / 40 W).
	needBody := map[string]any{"needPlanId": w.floor, "needId": w.need}
	c := decode[wiring.Candidates](t, api.Post(w.url("/connections/candidates"), cookie, needBody))
	if c.Reason != "" || len(c.Items) != 2 || c.Items[0].Units != 2 || !c.Items[0].Free || c.Items[0].Problem != nil {
		t.Fatalf("candidates %+v", c)
	}

	// Channel mode after connecting 2 units to channel 1: channel 1 takes no
	// further unit (overload), channel 2 takes the last one.
	want(t, api.Post(w.url("/connections"), cookie, w.connect(2, 1)), http.StatusCreated, "")
	ch := func(no int) wiring.Candidates {
		return decode[wiring.Candidates](t, api.Post(w.url("/connections/candidates"), cookie, map[string]any{
			"targetPlanId": w.board, "targetItemId": w.module, "outputKindId": w.dimmerKind, "channelNo": no}))
	}
	if c := ch(1); c.Reason != "limits_exceeded" && c.Reason != "no_free_channel" || len(c.Items) != 1 || c.Items[0].Problem == nil {
		t.Fatalf("channel 1 %+v", c)
	}
	if c := ch(2); c.Reason != "" || len(c.Items) != 1 || c.Items[0].Units != 1 {
		t.Fatalf("channel 2 %+v", c)
	}
	view = decode[wiring.Wiring](t, api.Get(w.url("/wiring"), cookie))
	if len(view.Items[0].Channels[0].ConnectionIDs) != 1 || view.Needs[0].ConnectedUnits != 2 || len(view.Connections) != 1 {
		t.Fatalf("view %+v", view)
	}

	// Complete need; bad input.
	want(t, api.Post(w.url("/connections"), cookie, w.connect(1, 2)), http.StatusCreated, "")
	if c := decode[wiring.Candidates](t, api.Post(w.url("/connections/candidates"), cookie, needBody)); c.Reason != "complete" {
		t.Fatalf("complete %+v", c)
	}
	want(t, api.Post(w.url("/connections/candidates"), cookie, map[string]any{}), http.StatusUnprocessableEntity, "connection.candidates_target")
}
