package installation

import "testing"

// Every text exists in every language, and the finding texts cover the
// codes the checks report (frontend list, D393/D419).
func TestMessages(t *testing.T) {
	for key := range messages["en"] {
		if _, ok := messages["de"][key]; !ok {
			t.Errorf("de lacks %s", key)
		}
	}
	for key := range messages["de"] {
		if _, ok := messages["en"][key]; !ok {
			t.Errorf("en lacks %s", key)
		}
	}
	codes := []string{"need_unconnected", "need_not_found", "target_not_found", "channel_not_found", "function_not_served", "motor_mismatch",
		"units_exceeded", "channel_conflict", "circuit_not_allowed", "channel_overload_w", "channel_overload_a", "module_overload_w",
		"module_overload_a", "limit_unknown", "min_load", "power_unknown", "board_over_capacity", "board_row_over_capacity",
		"bus_line_no_power_supply", "bus_line_current_exceeded", "bus_line_devices_exceeded", "bus_line_current_reserve",
		"bus_line_devices_reserve", "bus_current_unknown", "bus_device_unassigned", "wireless_no_gateway", "gateway_places_reserve",
		"gateway_places_exceeded", "gateway_no_router", "network_assignment_dangling", "address_duplicate", "address_outside_line",
		"bus_line_address_invalid"}
	for _, c := range codes {
		if _, ok := messages["en"]["f-"+c]; !ok {
			t.Errorf("no text for %s", c)
		}
	}
	if got := tr("de").finding("address_duplicate", map[string]any{"address": "1.1.1"}); got != "Adresse 1.1.1 ist mehrfach vergeben" {
		t.Errorf("finding %q", got)
	}
}
