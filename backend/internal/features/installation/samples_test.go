package installation_test

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"

	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// sampleSetup: a realistic KNX house: a board with two rows of 16 TE (power
// supply, 12-channel relay actuator whose relay pairs can act as blind
// outputs, 8-channel binary input, 6-channel dimmer, 4-channel curtain
// actuator, 4-channel dry contact input), a floorplan with eight zones
// (two of them sharing a prefix) and needs connected automatically, and
// sensors placed close together.
func sampleSetup(t *testing.T, lang string) world {
	t.Helper()
	w := world{api: apptest.New(t)}
	admin := w.api.Admin.Cookie
	post := func(path string, body map[string]any) uuid.UUID {
		t.Helper()
		resp := w.api.Post(path, admin, body)
		want(t, resp, http.StatusCreated, "")
		return decode[struct{ ID uuid.UUID }](t, resp).ID
	}
	switching := post("/api/function-types", map[string]any{"key": "switching", "name": text("Switching", "Schalten"), "allowsCircuit": true})
	dimming := post("/api/function-types", map[string]any{"key": "dimming", "name": text("Dimming", "Dimmen"), "allowsCircuit": true})
	blind := post("/api/function-types", map[string]any{"key": "blind", "name": text("Blind", "Jalousie")})
	contact := post("/api/function-types", map[string]any{"key": "contact", "name": text("Window contact", "Fensterkontakt")})
	led := post("/api/load-types", map[string]any{"key": "led", "name": text("LED", "LED"), "isActive": true})
	relayK := post("/api/output-kinds", map[string]any{"key": "relay_output", "name": text("Relay", "Relais"), "isActive": true,
		"functionTypeIds": []any{switching}})
	blindK := post("/api/output-kinds", map[string]any{"key": "blind_output", "name": text("Blind", "Jalousie"), "isActive": true,
		"functionTypeIds": []any{blind}, "alternatives": []any{map[string]any{"outputKindId": relayK, "count": 2}}})
	dimK := post("/api/output-kinds", map[string]any{"key": "dimmer_output", "name": text("Dimmer", "Dimmer"), "isActive": true,
		"functionTypeIds": []any{dimming}})
	inputK := post("/api/output-kinds", map[string]any{"key": "binary_input", "name": text("Input", "Eingang"), "isActive": true,
		"functionTypeIds": []any{contact}})
	knx := post("/api/product-types", map[string]any{"key": "knx", "name": text("KNX", "KNX"), "abbreviation": "KNX", "color": "#1f6feb",
		"isActive": true, "topology": "bus"})
	fields := []map[string]any{
		{"key": "relay_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": relayK},
		{"key": "blind_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": blindK},
		{"key": "pairs_ok", "type": "boolean", "meaning": "alternative_allowed", "outputKindId": blindK},
		{"key": "dim_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": dimK},
		{"key": "dim_led_w", "type": "number", "meaning": "channel_limit_w", "outputKindId": dimK, "loadTypeId": led},
		{"key": "in_ch", "type": "integer", "meaning": "channels_supplied", "outputKindId": inputK},
		{"key": "width_te", "type": "number", "meaning": "rail_width_te"},
		{"key": "bus_ma", "type": "number", "meaning": "bus_current_used_ma"},
		{"key": "bus_supply_ma", "type": "number", "meaning": "bus_current_supplied_ma"},
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
	product := func(cat uuid.UUID, model, name string, values map[string]any) uuid.UUID {
		p := post("/api/products", map[string]any{"productTypeId": knx, "categoryId": cat, "modelNumber": model, "name": text(name, name),
			"isActive": true, "attributes": values})
		return post("/api/products/"+p.String()+"/variants", map[string]any{"name": text(name, name), "price": "100", "isActive": true})
	}
	relayV := product(boardCat, "AKS-1216.03", "Switch actuator 12-fold", map[string]any{"relay_ch": 12, "pairs_ok": true, "width_te": 8, "bus_ma": 6})
	dimV := product(boardCat, "AKD-0601.02", "Dimming actuator 6-fold", map[string]any{"dim_ch": 6, "dim_led_w": 250, "width_te": 6, "bus_ma": 8})
	curtainV := product(boardCat, "JAL-0410.02", "Shutter actuator 4-fold", map[string]any{"blind_ch": 4, "width_te": 4, "bus_ma": 5})
	dryV := product(boardCat, "BE-04230.02", "Binary input 4-fold", map[string]any{"in_ch": 4, "width_te": 2, "bus_ma": 4})
	bin8V := product(boardCat, "BE-08000.02", "Binary input 8-fold", map[string]any{"in_ch": 8, "width_te": 2, "bus_ma": 4})
	psuV := product(boardCat, "STV-0640.01", "Power supply 640 mA", map[string]any{"width_te": 4, "bus_supply_ma": 640})
	sensorV := product(floorCat, "SCN-P360", "Presence detector", map[string]any{"bus_ma": 5})
	pushV := product(floorCat, "BE-TA55", "Push button 4-fold", map[string]any{"bus_ma": 5})

	tenant := w.api.NewTenant("Elektro Muster")
	w.user = w.api.NewUser(tenant, auth.RoleUser)
	resp := w.api.Post("/api/projects", w.user.Cookie, map[string]any{"name": "Haus Lindenweg", "language": lang, "productTypeIds": []any{knx},
		"customer": map[string]any{"name": "Familie Berg", "company": ""}})
	want(t, resp, http.StatusCreated, "")
	pr := decode[struct {
		ID       uuid.UUID
		Versions []struct{ ID uuid.UUID }
	}](t, resp)
	w.project, w.version = pr.ID, pr.Versions[0].ID

	resp = w.api.Post(w.url("/boards"), w.user.Cookie, map[string]any{"name": "UV EG", "rows": []any{map[string]any{"capacityTe": 16},
		map[string]any{"capacityTe": 16}}})
	want(t, resp, http.StatusCreated, "")
	w.board = decode[plans.Plan](t, resp).ID
	want(t, w.api.Post("/api/plans/"+w.board.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	b := decode[plans.BoardContent](t, w.api.Get("/api/plans/"+w.board.String()+"/board", w.user.Cookie))
	mod := func(row int, variant uuid.UUID, offset float64, label string) map[string]any {
		return map[string]any{"id": uuid.New(), "rowId": b.Rows[row].ID, "offsetTe": offset, "variantId": variant, "label": label,
			"existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}}
	}
	want(t, w.api.Put("/api/plans/"+w.board.String()+"/board", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": b.ContentUpdatedAt, "enclosureVariantId": nil,
		"rows": []any{map[string]any{"id": b.Rows[0].ID, "capacityTe": 16}, map[string]any{"id": b.Rows[1].ID, "capacityTe": 16}},
		"modules": []any{mod(0, psuV, 0, ""), mod(0, relayV, 4, "Lights"), mod(0, bin8V, 12, "Contacts"),
			mod(1, dimV, 0, "Dimmer living"), mod(1, curtainV, 6, "Blinds"), mod(1, dryV, 10, "")}}), http.StatusOK, "")

	w.floor = w.floorplan(t)
	want(t, w.api.Post("/api/plans/"+w.floor.String()+"/lock", w.user.Cookie), http.StatusOK, "")
	c := decode[plans.PlanContent](t, w.api.Get("/api/plans/"+w.floor.String()+"/content", w.user.Cookie))
	type zdef struct {
		name, short string
		x0, y0      float64
	}
	zdefs := []zdef{{"Living room", "", 0, 0}, {"Kitchen", "", 200, 0}, {"Bathroom", "", 400, 0}, {"Bath upstairs", "", 600, 0},
		{"Hall", "", 0, 250}, {"Hallway upstairs", "", 200, 250}, {"Office", "Büro", 400, 250}, {"Bedroom", "", 600, 250}}
	var zones, needs, placements []any
	needNo := 0
	need := func(zone uuid.UUID, ft uuid.UUID, qty int, power any, load any, label string, x, y float64) {
		needNo++
		n := map[string]any{"id": uuid.New(), "zoneId": zone, "functionTypeId": ft, "quantity": qty, "powerW": power, "loadTypeId": load,
			"label": label, "note": "", "x": x, "y": y}
		needs = append(needs, n)
	}
	for i, z := range zdefs {
		id := uuid.New()
		zm := map[string]any{"id": id, "name": z.name, "color": []string{"#22aa66", "#e0a800", "#4f7cff", "#c2410c"}[i%4], "opacity": 0.2,
			"points": [][2]float64{{z.x0, z.y0}, {z.x0 + 200, z.y0}, {z.x0 + 200, z.y0 + 250}, {z.x0, z.y0 + 250}}}
		if z.short != "" {
			zm["shortName"] = z.short
		}
		zones = append(zones, zm)
		cx, cy := z.x0+100, z.y0+125
		need(id, switching, 1, nil, nil, "Ceiling", cx-40, cy-60)
		need(id, blind, 1, nil, nil, "", cx+60, cy-90)
		need(id, contact, 1, nil, nil, "Window", cx+70, cy+80)
		if i < 6 {
			need(id, dimming, 1+i%3, "7", led, map[bool]string{true: "Spots", false: "Wall lights"}[i%2 == 0], cx-50, cy+50)
		}
		if i == 0 || i == 1 {
			need(id, switching, 2, nil, nil, "Sockets", cx+40, cy+20)
		}
		// Devices close together (label collisions).
		placements = append(placements,
			map[string]any{"id": uuid.New(), "variantId": sensorV, "x": cx, "y": cy, "width": 24, "height": 24, "rotation": 0,
				"label": "PD " + z.name, "existing": i == 7, "addonVariantIds": []any{}, "instanceValues": map[string]any{}},
			map[string]any{"id": uuid.New(), "variantId": pushV, "x": cx + 18, "y": cy + 14, "width": 20, "height": 20, "rotation": 0,
				"label": "Push " + z.name, "existing": false, "addonVariantIds": []any{}, "instanceValues": map[string]any{}})
	}
	want(t, w.api.Put("/api/plans/"+w.floor.String()+"/content", w.user.Cookie, map[string]any{
		"expectedContentUpdatedAt": c.ContentUpdatedAt, "scale": nil, "zones": zones, "placements": placements, "needs": needs,
	}), http.StatusOK, "")
	resp = w.api.Post(w.url("/auto-connect/preview"), w.user.Cookie, map[string]any{"scope": "all"})
	want(t, resp, http.StatusOK, "")
	checksum := decode[struct{ Checksum string }](t, resp).Checksum
	want(t, w.api.Post(w.url("/auto-connect/apply"), w.user.Cookie, map[string]any{"scope": "all", "expectedChecksum": checksum}), http.StatusOK, "")
	want(t, w.api.Get(w.url("/networks"), w.user.Cookie), http.StatusOK, "")
	want(t, w.api.Post(w.url("/addresses/assign"), w.user.Cookie, map[string]any{}), http.StatusOK, "")
	return w
}

// TestRenderSamples writes a realistic manual and labels (de, en) to
// SAMPLES_DIR for a visual check (skipped without it).
func TestRenderSamples(t *testing.T) {
	dir := os.Getenv("SAMPLES_DIR")
	if dir == "" {
		t.Skip("SAMPLES_DIR not set")
	}
	for _, lang := range []string{"de", "en"} {
		w := sampleSetup(t, lang)
		for _, kind := range []string{"installation_manual", "channel_labels"} {
			_, data := generate(t, w, kind)
			name := filepath.Join(dir, fmt.Sprintf("%s-%s.docx", strings.Split(kind, "_")[0], lang))
			if err := os.WriteFile(name, data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
}
