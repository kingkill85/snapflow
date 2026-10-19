package apptest

import (
	"net/http"

	"github.com/google/uuid"
)

// BoardCatalog is a catalog for board and network tests (step 3c): a bus
// system KNX and a wireless system Zigbee, catalog fields with the meanings
// rail_width_te, enclosure_rows, enclosure_te_per_row,
// bus_current_used_ma, bus_current_supplied_ma and wireless_places_supplied,
// a board category and a floorplan category, and one variant per product.
type BoardCatalog struct {
	KNX, Zigbee uuid.UUID
	// Board products (KNX): Actuator 4 TE 10 mA, PSU 2 TE supplies 640 mA,
	// Enclosure 2 rows × 12 TE, NoWidth (no width, no current).
	Actuator, PSU, Enclosure, NoWidth uuid.UUID
	// Floorplan products: Sensor (KNX, 1 TE, 5 mA), Gateway (Zigbee, 50
	// places), Bulb (Zigbee device).
	Sensor, Gateway, Bulb uuid.UUID
}

// NewBoardCatalog creates the BoardCatalog as the admin.
func (a *API) NewBoardCatalog() BoardCatalog {
	a.t.Helper()
	post := func(path string, body map[string]any) uuid.UUID {
		a.t.Helper()
		resp := a.Post(path, a.Admin.Cookie, body)
		if resp.Code != http.StatusCreated {
			a.t.Fatalf("apptest: POST %s: got %d: %s", path, resp.Code, resp.Body)
		}
		return decodeID(a.t, resp.Body.Bytes())
	}
	text := func(en string) map[string]string { return map[string]string{"en": en} }
	var c BoardCatalog
	c.KNX = post("/api/product-types", map[string]any{"key": "knx", "name": text("KNX"), "abbreviation": "KNX", "isActive": true, "topology": "bus"})
	c.Zigbee = post("/api/product-types", map[string]any{"key": "zigbee", "name": text("Zigbee"), "abbreviation": "ZB", "isActive": true,
		"topology": "wireless", "defaultWirelessPlacesUsed": 1})
	for _, f := range []map[string]any{
		{"key": "width_te", "type": "number", "unit": "TE", "meaning": "rail_width_te"},
		{"key": "enc_rows", "type": "integer", "meaning": "enclosure_rows"},
		{"key": "enc_te", "type": "number", "meaning": "enclosure_te_per_row"},
		{"key": "bus_ma", "type": "number", "meaning": "bus_current_used_ma"},
		{"key": "bus_supply_ma", "type": "number", "meaning": "bus_current_supplied_ma"},
		{"key": "places", "type": "integer", "meaning": "wireless_places_supplied"},
	} {
		f["label"] = text(f["key"].(string))
		post("/api/catalog-fields", f)
	}
	attrs := []any{}
	for _, k := range []string{"width_te", "enc_rows", "enc_te", "bus_ma", "bus_supply_ma", "places"} {
		typ := "number"
		if k == "enc_rows" || k == "places" {
			typ = "integer"
		}
		attrs = append(attrs, map[string]any{"key": k, "label": text(k), "type": typ, "fieldKey": k})
	}
	board := post("/api/categories", map[string]any{"key": "board_devices", "name": text("Board"), "isActive": true, "mounting": "board",
		"attributes": attrs, "instanceAttributes": []any{}})
	floor := post("/api/categories", map[string]any{"key": "floor_devices", "name": text("Floor"), "isActive": true, "mounting": "floorplan",
		"attributes": attrs, "instanceAttributes": []any{}})
	product := func(typeID, categoryID uuid.UUID, model string, values map[string]any) uuid.UUID {
		a.t.Helper()
		p := post("/api/products", map[string]any{"productTypeId": typeID, "categoryId": categoryID, "modelNumber": model,
			"name": text(model), "isActive": true, "attributes": values})
		return post("/api/products/"+p.String()+"/variants", map[string]any{"name": text(model), "price": "10.00", "isActive": true})
	}
	c.Actuator = product(c.KNX, board, "ACT", map[string]any{"width_te": 4, "bus_ma": 10})
	c.PSU = product(c.KNX, board, "PSU", map[string]any{"width_te": 2, "bus_supply_ma": 640})
	c.Enclosure = product(c.KNX, board, "ENC", map[string]any{"enc_rows": 2, "enc_te": 12})
	c.NoWidth = product(c.KNX, board, "NOW", map[string]any{})
	c.Sensor = product(c.KNX, floor, "SEN", map[string]any{"width_te": 1, "bus_ma": 5})
	c.Gateway = product(c.Zigbee, floor, "GW", map[string]any{"places": 50})
	c.Bulb = product(c.Zigbee, floor, "BULB", map[string]any{})
	return c
}
