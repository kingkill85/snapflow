package installation_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/installation"
	"github.com/kingkill85/snapflow/backend/internal/features/installation/store"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/document/docx/docxtest"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

func want(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("got %d, want %d: %s", resp.Code, status, resp.Body)
	}
	if code != "" {
		var p struct {
			Code   string `json:"code"`
			Fields []struct {
				Code string `json:"code"`
			} `json:"fields"`
		}
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		if p.Code != code && (len(p.Fields) == 0 || p.Fields[0].Code != code) {
			t.Fatalf("code %q, want %q: %s", p.Code, code, resp.Body)
		}
	}
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode: %v: %s", err, resp.Body)
	}
	return v
}

func text(en, de string) map[string]string { return map[string]string{"en": en, "de": de} }

type world struct {
	api                 *apptest.API
	user                apptest.Session
	project, version    uuid.UUID
	floor, board        uuid.UUID
	zone, spots, blinds uuid.UUID
	dimmer, psu, sensor uuid.UUID
	existing            uuid.UUID
	gateway, bulb       uuid.UUID
	dimKind             uuid.UUID
}

// setup: a KNX villa: function types dimming (circuits) and blind; a
// dimmer actuator (4 channels, 4 TE, 10 mA), a blind actuator (2 channels)
// and a power supply on a board; a floorplan with the zone "Living room"
// (spots 3 × 40 W LED with a symbol, a blind), a KNX sensor and an
// existing sensor.
func setup(t *testing.T, lang string) world {
	t.Helper()
	api := apptest.New(t)
	w := world{api: api}
	admin := api.Admin.Cookie
	post := func(path string, body map[string]any) uuid.UUID {
		t.Helper()
		resp := api.Post(path, admin, body)
		want(t, resp, http.StatusCreated, "")
		return decode[struct{ ID uuid.UUID }](t, resp).ID
	}
	obj := func(key, en, dpst string) map[string]any {
		return map[string]any{"key": key, "name": text(en, en), "dpst": dpst}
	}
	dimming := post("/api/function-types", map[string]any{"key": "dimming", "name": text("Dimming", "Dimmen"), "allowsCircuit": true,
		"knxObjects": []any{obj("switch", "Switch", "DPST-1-1"), obj("switch_status", "Switch status", "DPST-1-1"),
			obj("dim_relative", "Dim relative", "DPST-3-7"), obj("brightness", "Brightness value", "DPST-5-1"),
			obj("brightness_status", "Brightness status", "DPST-5-1")}})
	blind := post("/api/function-types", map[string]any{"key": "blind", "name": text("Blind", "Jalousie"),
		"knxObjects": []any{obj("up_down", "Up/Down", "DPST-1-8"), obj("stop_step", "Stop/Step", "DPST-1-7"),
			obj("position", "Position", "DPST-5-1"), obj("position_status", "Position status", "DPST-5-1")}})
	led := post("/api/load-types", map[string]any{"key": "led", "name": text("LED", "LED"), "isActive": true})
	w.dimKind = post("/api/output-kinds", map[string]any{"key": "dimmer_output", "name": text("Dimmer", "Dimmer"), "isActive": true,
		"functionTypeIds": []any{dimming}})
	blindKind := post("/api/output-kinds", map[string]any{"key": "blind_output", "name": text("Blind", "Jalousie"), "isActive": true,
		"functionTypeIds": []any{blind}})
	knx := post("/api/product-types", map[string]any{"key": "knx", "name": text("KNX", "KNX"), "abbreviation": "KNX", "color": "#1f6feb",
		"isActive": true, "topology": "bus"})
	fields := []map[string]any{
		{"key": "dim_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": w.dimKind},
		{"key": "dim_led_w", "type": "number", "meaning": "channel_limit_w", "outputKindId": w.dimKind, "loadTypeId": led},
		{"key": "blind_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": blindKind},
		{"key": "width_te", "type": "number", "meaning": "rail_width_te"},
		{"key": "bus_ma", "type": "number", "meaning": "bus_current_used_ma"},
		{"key": "bus_supply_ma", "type": "number", "meaning": "bus_current_supplied_ma"},
		{"key": "places", "type": "integer", "meaning": "wireless_places_supplied"},
	}
	attrs := []any{}
	for _, f := range fields {
		f["label"] = text(f["key"].(string), f["key"].(string))
		post("/api/catalog-fields", f)
		attrs = append(attrs, map[string]any{"key": f["key"], "label": f["label"], "type": f["type"], "fieldKey": f["key"]})
	}
	boardCat := post("/api/categories", map[string]any{"key": "actuators", "name": text("Actuators", "Aktoren"), "isActive": true, "mounting": "board",
		"attributes": attrs, "instanceAttributes": []any{}})
	floorCat := post("/api/categories", map[string]any{"key": "sensors", "name": text("Sensors", "Sensoren"), "isActive": true, "mounting": "floorplan",
		"attributes": attrs, "instanceAttributes": []any{}})
	zigbee := post("/api/product-types", map[string]any{"key": "zigbee", "name": text("Zigbee", "Zigbee"), "abbreviation": "ZB",
		"isActive": true, "topology": "wireless", "defaultWirelessPlacesUsed": 1})
	system := knx
	product := func(cat uuid.UUID, model, name string, values map[string]any) uuid.UUID {
		p := post("/api/products", map[string]any{"productTypeId": system, "categoryId": cat, "modelNumber": model, "name": text(name, name),
			"isActive": true, "attributes": values})
		return post("/api/products/"+p.String()+"/variants", map[string]any{"name": text(name, name), "price": "123.45", "isActive": true})
	}
	dimmerV := product(boardCat, "DIM-4", "Dimmer actuator", map[string]any{"dim_ch": 4, "dim_led_w": 300, "width_te": 4, "bus_ma": 10})
	blindV := product(boardCat, "JAL-2", "Blind actuator", map[string]any{"blind_ch": 2, "width_te": 2, "bus_ma": 8})
	psuV := product(boardCat, "PSU-640", "Power supply", map[string]any{"width_te": 4, "bus_supply_ma": 640})
	sensorV := product(floorCat, "PIR-1", "Presence sensor", map[string]any{"bus_ma": 5})
	system = zigbee
	gatewayV := product(floorCat, "ZGW", "Zigbee gateway", map[string]any{"places": 50})
	bulbV := product(floorCat, "ZB-BULB", "Zigbee bulb", map[string]any{})

	tenant := api.NewTenant("Acme")
	w.user = api.NewUser(tenant, auth.RoleUser)
	resp := api.Post("/api/projects", w.user.Cookie, map[string]any{"name": "Villa Sommer", "language": lang, "productTypeIds": []any{knx, zigbee},
		"customer": map[string]any{"name": "Anna Kunde", "company": "Kunde GmbH"}})
	want(t, resp, http.StatusCreated, "")
	pr := decode[struct {
		ID       uuid.UUID
		Versions []struct{ ID uuid.UUID }
	}](t, resp)
	w.project, w.version = pr.ID, pr.Versions[0].ID

	// Board: dimmer, blind actuator, power supply on one row.
	resp = api.Post("/api/versions/"+w.version.String()+"/boards", w.user.Cookie, map[string]any{"name": "Main board", "rows": []any{map[string]any{"capacityTe": 12}}})
	want(t, resp, http.StatusCreated, "")
	w.board = decode[plans.Plan](t, resp).ID
	want(t, api.Post("/api/plans/"+w.board.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	b := decode[plans.BoardContent](t, api.Get("/api/plans/"+w.board.String()+"/board", w.user.Cookie))
	w.dimmer, w.psu = uuid.New(), uuid.New()
	blindMod := uuid.New()
	mod := func(id, variant uuid.UUID, offset float64, label string) map[string]any {
		return map[string]any{"id": id, "rowId": b.Rows[0].ID, "offsetTe": offset, "variantId": variant, "label": label,
			"existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}}
	}
	want(t, api.Put("/api/plans/"+w.board.String()+"/board", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil, "rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 12}},
		"modules": []any{mod(w.psu, psuV, 0, "PSU"), mod(w.dimmer, dimmerV, 4, "Lights"), mod(blindMod, blindV, 8, "")}}), http.StatusOK, "")

	// Floorplan: zone, needs (spots with a symbol), a sensor, an existing one.
	w.floor = w.floorplan(t)
	w.zone, w.spots, w.blinds, w.sensor, w.existing = uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	w.gateway, w.bulb = uuid.New(), uuid.New()
	want(t, api.Post("/api/plans/"+w.floor.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	c := decode[plans.PlanContent](t, api.Get("/api/plans/"+w.floor.String()+"/content", w.user.Cookie))
	place := func(id, variant uuid.UUID, x float64, label string, existing bool) map[string]any {
		return map[string]any{"id": id, "variantId": variant, "x": x, "y": 100, "width": 40, "height": 40, "rotation": 0,
			"label": label, "existing": existing, "addonVariantIds": []any{}, "instanceValues": map[string]any{}}
	}
	x, y := 450.0, 300.0
	want(t, api.Put("/api/plans/"+w.floor.String()+"/content", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil,
		"zones": []any{map[string]any{"id": w.zone, "name": "Living room", "color": "#22aa66", "opacity": 0.25,
			"points": [][2]float64{{0, 0}, {600, 0}, {600, 400}, {0, 400}}}},
		"placements": []any{place(w.sensor, sensorV, 100, "PIR living", false), place(w.existing, sensorV, 200, "Old PIR", true),
			place(w.gateway, gatewayV, 500, "Hub", false), place(w.bulb, bulbV, 650, "Reading lamp", false)},
		"needs": []any{
			map[string]any{"id": w.spots, "zoneId": w.zone, "functionTypeId": dimming, "quantity": 3, "powerW": "40", "loadTypeId": led,
				"label": "Ceiling spots", "note": "", "x": x, "y": y},
			map[string]any{"id": w.blinds, "zoneId": w.zone, "functionTypeId": blind, "quantity": 1, "powerW": nil, "loadTypeId": nil,
				"label": "", "note": "", "x": nil, "y": nil},
		},
	}), http.StatusOK, "")
	// Connect everything, then address it.
	resp = api.Post(w.url("/auto-connect/preview"), w.user.Cookie, map[string]any{"scope": "all"})
	want(t, resp, http.StatusOK, "")
	checksum := decode[struct{ Checksum string }](t, resp).Checksum
	want(t, api.Post(w.url("/auto-connect/apply"), w.user.Cookie, map[string]any{"scope": "all", "expectedChecksum": checksum}), http.StatusOK, "")
	want(t, api.Get(w.url("/networks"), w.user.Cookie), http.StatusOK, "")
	want(t, api.Post(w.url("/addresses/assign"), w.user.Cookie, map[string]any{}), http.StatusOK, "")
	want(t, api.Put(w.url("/addresses"), w.user.Cookie, map[string]any{"addresses": []any{
		map[string]any{"planId": w.floor, "itemId": w.bulb, "ieee": "00:12:4b:00:1c:a1:b2:c3", "note": "behind the sofa"}}}), http.StatusOK, "")
	return w
}

func (w world) url(rest string) string { return "/api/versions/" + w.version.String() + rest }

func (w world) floorplan(t *testing.T) uuid.UUID {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 800, 500))
	for yy := range 500 {
		for xx := range 800 {
			img.Set(xx, yy, color.NRGBA{240, 240, uint8(200 + xx%50), 255})
		}
	}
	var png1 bytes.Buffer
	if err := png.Encode(&png1, img); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("name", "Ground floor")
	part, _ := mw.CreateFormFile("image", "plan.png")
	_, _ = part.Write(png1.Bytes())
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, w.url("/plans"), &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Cookie", w.user.Cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	w.api.Adapter().ServeHTTP(resp, req)
	want(t, resp, http.StatusCreated, "")
	return decode[plans.Plan](t, resp).ID
}

func unzip(t *testing.T, data []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

// plain strips the XML tags of a document part.
func plain(xml string) string {
	var b strings.Builder
	in := false
	for _, r := range xml {
		switch {
		case r == '<':
			in = true
		case r == '>':
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func TestGroupAddressesCSV(t *testing.T) {
	w := setup(t, "en")
	resp := w.api.Get(w.url("/exports/knx-group-addresses.csv"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	if ct := resp.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("content type %q", ct)
	}
	got := resp.Body.String()
	// Golden: the ETS 1/1 layout, TAB separated (D422). Spots on Lights
	// ch 1 (dimmer objects), the blind on the blind actuator (blind
	// objects), from the function types' KNX objects.
	row := func(fields ...string) string { return `"` + strings.Join(fields, "\"\t\"") + `"` }
	golden := "\ufeff" + strings.Join([]string{
		row("Group name", "Address", "Central", "Unfiltered", "Description", "DatapointType", "Security"),
		row("Ground floor", "1/-/-", "", "", "", "", "Auto"),
		row("Living room", "1/0/-", "", "", "", "", "Auto"),
		row("Living room Ceiling spots Switch", "1/0/1", "", "", "Main board D2 Lights Dimmer 1", "DPST-1-1", "Auto"),
		row("Living room Ceiling spots Switch status", "1/0/2", "", "", "Main board D2 Lights Dimmer 1", "DPST-1-1", "Auto"),
		row("Living room Ceiling spots Dim relative", "1/0/3", "", "", "Main board D2 Lights Dimmer 1", "DPST-3-7", "Auto"),
		row("Living room Ceiling spots Brightness value", "1/0/4", "", "", "Main board D2 Lights Dimmer 1", "DPST-5-1", "Auto"),
		row("Living room Ceiling spots Brightness status", "1/0/5", "", "", "Main board D2 Lights Dimmer 1", "DPST-5-1", "Auto"),
		row("Living room Blind Up/Down", "1/0/6", "", "", "Main board D3 Blind 1", "DPST-1-8", "Auto"),
		row("Living room Blind Stop/Step", "1/0/7", "", "", "Main board D3 Blind 1", "DPST-1-7", "Auto"),
		row("Living room Blind Position", "1/0/8", "", "", "Main board D3 Blind 1", "DPST-5-1", "Auto"),
		row("Living room Blind Position status", "1/0/9", "", "", "Main board D3 Blind 1", "DPST-5-1", "Auto"),
	}, "\r\n") + "\r\n"
	if got != golden {
		t.Errorf("csv:\n%s\nwant:\n%s", got, golden)
	}
	// Stable: the same again (now from the stored rows).
	if again := w.api.Get(w.url("/exports/knx-group-addresses.csv"), w.user.Cookie).Body.String(); again != got {
		t.Error("not deterministic")
	}
	// The 3/1 layout, comma separated.
	resp = w.api.Get(w.url("/exports/knx-group-addresses.csv?format=3-1"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	if lines := strings.Split(resp.Body.String(), "\r\n"); len(lines) != 13 ||
		lines[3] != `"","","Living room Ceiling spots Switch","1/0/1","","","Main board D2 Lights Dimmer 1","DPST-1-1","Auto"` {
		t.Errorf("3/1: %q", lines)
	}
	want(t, w.api.Get(w.url("/exports/knx-group-addresses.csv?format=x"), w.user.Cookie), http.StatusUnprocessableEntity, "")
	var stored int
	if err := w.api.DB.QueryRow(t.Context(), `SELECT count(*) FROM group_addresses WHERE version_id = $1`, w.version).Scan(&stored); err != nil || stored != 9 {
		t.Errorf("stored %d %v", stored, err)
	}

	// Assign: nothing new; a plain read user cannot.
	resp = w.api.Post(w.url("/group-addresses/assign"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	if sum := decode[installation.GroupAddressSummary](t, resp); sum.Added != 0 || sum.Total != 9 {
		t.Errorf("summary %+v", sum)
	}

	// A version copy keeps the group addresses (plan ids mapped).
	resp = w.api.Post("/api/projects/"+w.project.String()+"/versions", w.user.Cookie, map[string]any{"sourceVersionId": w.version, "name": "V2"})
	want(t, resp, http.StatusCreated, "")
	copyID := decode[struct{ ID uuid.UUID }](t, resp).ID
	resp = w.api.Get("/api/versions/"+copyID.String()+"/exports/knx-group-addresses.csv", w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	if resp.Body.String() != got {
		t.Errorf("copy:\n%s", resp.Body.String())
	}
	if err := w.api.DB.QueryRow(t.Context(), `SELECT count(*) FROM group_addresses a JOIN plans p ON p.id = a.need_plan_id
		WHERE a.version_id = $1 AND p.version_id = $1`, copyID).Scan(&stored); err != nil || stored != 9 {
		t.Errorf("copied %d %v", stored, err)
	}

	// Read-only projects refuse the assignment, still export.
	if _, err := w.api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, w.project); err != nil {
		t.Fatal(err)
	}
	want(t, w.api.Post(w.url("/group-addresses/assign"), w.user.Cookie), http.StatusConflict, "project.read_only")
	want(t, w.api.Get(w.url("/exports/knx-group-addresses.csv"), w.user.Cookie), http.StatusOK, "")
	other := w.api.NewUser(w.api.NewTenant("Other"), auth.RoleUser)
	want(t, w.api.Post(w.url("/group-addresses/assign"), other.Cookie), http.StatusNotFound, "")
}

func TestCommissioningLists(t *testing.T) {
	w := setup(t, "de")
	resp := w.api.Get(w.url("/exports/knx-devices.xlsx"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	f, err := excelize.OpenReader(bytes.NewReader(resp.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	sheets := f.GetSheetList()
	if len(sheets) != 1 || sheets[0] != "KNX 1" {
		t.Fatalf("sheets %v", sheets)
	}
	rows, _ := f.GetRows(sheets[0])
	// Header, dimmer, blind actuator (board first), sensor, existing sensor;
	// the power supply has no address and is left out.
	if len(rows) != 5 || rows[0][0] != "Gerät" || rows[1][0] != "Main board D2 Lights" || rows[1][4] != "1.1.1" ||
		!strings.Contains(rows[1][5], "Dimmer 1: Living room Ceiling spots 3 × 40 W LED") || rows[4][len(rows[4])-1] != "ja" {
		t.Errorf("rows %q", rows)
	}
	// Wireless (EUI-64): a sheet per gateway with the gateway and its
	// devices; the former path still answers.
	want(t, w.api.Get(w.url("/exports/zigbee-devices.xlsx"), w.user.Cookie), http.StatusOK, "")
	resp = w.api.Get(w.url("/exports/wireless-devices.xlsx"), w.user.Cookie)
	want(t, resp, http.StatusOK, "")
	f, err = excelize.OpenReader(bytes.NewReader(resp.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	rows, _ = f.GetRows("Hub")
	if len(rows) != 3 || rows[2][0] != "Reading lamp" || rows[2][4] != "00124B001CA1B2C3" || rows[2][6] != "behind the sofa" {
		t.Errorf("zigbee rows %q (sheets %v)", rows, f.GetSheetList())
	}
	// HDL: a valid workbook without devices here.
	for _, kind := range []string{"hdl-commissioning"} {
		resp := w.api.Get(w.url("/exports/"+kind+".xlsx"), w.user.Cookie)
		want(t, resp, http.StatusOK, "")
		if _, err := excelize.OpenReader(bytes.NewReader(resp.Body.Bytes())); err != nil {
			t.Errorf("%s: %v", kind, err)
		}
	}
	other := w.api.NewUser(w.api.NewTenant("Other"), auth.RoleUser)
	want(t, w.api.Get(w.url("/exports/knx-devices.xlsx"), other.Cookie), http.StatusNotFound, "")
}

func generate(t *testing.T, w world, kind string) (installation.GeneratedDocument, []byte) {
	t.Helper()
	resp := w.api.Post(w.url("/documents"), w.user.Cookie, map[string]any{"kind": kind})
	want(t, resp, http.StatusCreated, "")
	doc := decode[installation.GeneratedDocument](t, resp)
	dl := w.api.Get(doc.DownloadURL, w.user.Cookie)
	want(t, dl, http.StatusOK, "")
	return doc, dl.Body.Bytes()
}

func TestDocuments(t *testing.T) {
	w := setup(t, "en")
	doc, data := generate(t, w, "installation_manual")
	if doc.Kind != "installation_manual" || doc.Sequence != 1 || !strings.HasSuffix(doc.Number, "-IM01") || doc.Exporter != "docx" {
		t.Errorf("doc %+v", doc)
	}
	parts := unzip(t, data)
	body := plain(parts["word/document.xml"])
	for _, s := range []string{"Installation manual", "Overview", "Bus lines", "KNX 1", "Main board", "D2", "Lights", "Dimmer 1",
		"Ceiling spots", "3 × 40 W LED", "1.1.1", "existing", "Living room", "Free channels", "Kunde GmbH", "Cables and terminals",
		"Gateways", "Hub", "00124B001CA1B2C3", "Reading lamp", "1.1 (default)"} {
		if !strings.Contains(body, s) {
			t.Errorf("manual lacks %q", s)
		}
	}
	for _, s := range []string{"123.45", "123,45", "USD"} {
		if strings.Contains(body, s) {
			t.Errorf("manual shows a price: %q", s)
		}
	}
	images := 0
	for name := range parts {
		if strings.HasPrefix(name, "word/media/") {
			images++
		}
	}
	if images < 2 { // the board drawing and the plan
		t.Errorf("%d images", images)
	}

	lb, data := generate(t, w, "channel_labels")
	if !strings.HasSuffix(lb.Number, "-LB01") {
		t.Errorf("labels %+v", lb)
	}
	body = plain(unzip(t, data)["word/document.xml"])
	for _, s := range []string{"Channel labels", "Row 1", "D2 Lights", "1LivCeiling spots", "D3", "TE 1–12"} {
		if !strings.Contains(body, s) {
			t.Errorf("labels lack %q", s)
		}
	}
	// A second manual counts on its own sequence.
	doc2, _ := generate(t, w, "installation_manual")
	if doc2.Sequence != 2 {
		t.Errorf("sequence %d", doc2.Sequence)
	}
	list := decode[[]installation.GeneratedDocument](t, w.api.Get(w.url("/documents"), w.user.Cookie))
	if len(list) != 3 {
		t.Errorf("list %d", len(list))
	}
	want(t, w.api.Post(w.url("/documents"), w.user.Cookie, map[string]any{"kind": "x"}), http.StatusUnprocessableEntity, "")

	// Completed projects still generate (like proposals); addresses are
	// read-only there.
	if _, err := w.api.DB.Exec(t.Context(), `UPDATE projects SET status = 'completed' WHERE id = $1`, w.project); err != nil {
		t.Fatal(err)
	}
	generate(t, w, "channel_labels")
	want(t, w.api.Put(w.url("/addresses"), w.user.Cookie, map[string]any{"addresses": []any{}}), http.StatusConflict, "project.read_only")
	if a := decode[networks.Addresses](t, w.api.Get(w.url("/addresses"), w.user.Cookie)); a.Can.Update {
		t.Error("read-only project can update addresses")
	}

	// Others see nothing; a plain user cannot delete (projects.delete).
	other := w.api.NewUser(w.api.NewTenant("Other"), auth.RoleUser)
	want(t, w.api.Get(doc.DownloadURL, other.Cookie), http.StatusNotFound, "")
	want(t, w.api.Get(w.url("/documents"), other.Cookie), http.StatusNotFound, "")

	// Row-level security.
	ctx := t.Context()
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
	if rows, err := store.New(tx).ListDocuments(ctx, w.version); err != nil || len(rows) != 0 {
		t.Errorf("foreign documents: %v %v", rows, err)
	}
}

// TestLibreOffice converts a German and an English manual and labels with
// LibreOffice (skipped without soffice, failing with REQUIRE_SOFFICE=1).
// KEEP_PDF=<dir> keeps the files.
func TestLibreOffice(t *testing.T) {
	soffice := docxtest.Soffice(t)
	files := map[string][]byte{}
	for _, lang := range []string{"de", "en"} {
		w := setup(t, lang)
		_, manual := generate(t, w, "installation_manual")
		_, labels := generate(t, w, "channel_labels")
		files["manual-"+lang+".docx"] = manual
		files["labels-"+lang+".docx"] = labels
	}
	docxtest.ConvertToPDF(t, soffice, files)
}
