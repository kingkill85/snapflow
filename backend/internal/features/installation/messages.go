package installation

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// messages are the texts of the installation documents and lists per
// content language (the project's language, D253). English is the fallback.
var messages = map[string]map[string]string{
	"en": {
		"manualTitle":            "Installation manual",
		"manualIntro":            "Built from the planned data of this version: boards, channels, connections, addresses and the open check findings. Prices are not part of this document.",
		"labelsTitle":            "Channel labels",
		"labelsIntro":            "One strip per board row at 17.5 mm per module width (TE), 15 mm high; cut along the dashed lines. Per channel: number, zone, need; \"1+2\": two channels used as one; \"–\": free.",
		"teRange":                "TE %d–%d",
		"number":                 "Document no.",
		"date":                   "Date",
		"project":                "Project",
		"version":                "Version",
		"page":                   "Page {page} of {pages}",
		"overview":               "Overview",
		"busLines":               "Bus lines",
		"gateways":               "Gateways",
		"openFindings":           "Open findings",
		"noFindings":             "No open errors or warnings.",
		"noCables":               "Cables and terminals are not planned in SnapFlow; plan them on site.",
		"enclosure":              "Enclosure",
		"row":                    "Row %d",
		"modules":                "Modules",
		"channels":               "Channels",
		"freeChannels":           "Free channels",
		"noFreeChannels":         "None.",
		"noModules":              "The board has no modules.",
		"noBoards":               "The version has no boards.",
		"zonesOf":                "%s – devices and needs",
		"noZone":                 "No zone",
		"device":                 "Device",
		"existingMark":           "existing",
		"circuitMark":            "Circuit",
		"notConnected":           "%d not connected",
		"planLegend":             "Letters: devices, numbered circles: needs (both explained in the zone tables). Hatched: existing devices.",
		"colMark":                "Mark",
		"defaultMark":            "default",
		"colLine":                "Line",
		"colSystem":              "System",
		"colPrefix":              "Address",
		"colSupplies":            "Power supplies",
		"colCurrent":             "Current used / supplied",
		"colDevices":             "Devices",
		"colGateway":             "Gateway",
		"colLocation":            "Location",
		"colPlaces":              "Places used / supplied",
		"colSeverity":            "Severity",
		"colFinding":             "Finding",
		"colPos":                 "Pos.",
		"colRow":                 "Row",
		"colLabel":               "Label",
		"colProduct":             "Product",
		"colModel":               "Model",
		"colTE":                  "TE",
		"colAddress":             "Address",
		"colChannel":             "Channel",
		"colZone":                "Zone",
		"colNeed":                "Need",
		"colLoad":                "Load",
		"colCircuit":             "Circuit",
		"colDevice":              "Device",
		"colNetwork":             "Line / gateway",
		"colNo":                  "No.",
		"colConnected":           "Connected to",
		"colSubnet":              "Subnet",
		"colDeviceID":            "Device ID",
		"colChannels":            "Channels and loads",
		"colNote":                "Note",
		"colExisting":            "Existing",
		"colIEEE":                "IEEE address",
		"yes":                    "yes",
		"noDevices":              "No devices",
		"severity-error":         "Error",
		"severity-warning":       "Warning",
		"severity-info":          "Info",
		"fileGroupAddresses":     "KNX group addresses",
		"file-hdl-commissioning": "HDL commissioning list",
		"file-wireless-devices":  "Wireless device list (EUI-64)",
		"sheetWithoutLine":       "Without line",
		"sheetWithoutGateway":    "Without gateway",
		"file-knx-devices":       "KNX device list",
		"gaSwitch":               "Switch",
		"gaSwitchStatus":         "Switch status",
		"gaDimRelative":          "Dim relative",
		"gaBrightness":           "Brightness value",
		"gaBrightnessStatus":     "Brightness status",
		"gaUpDown":               "Up/Down",
		"gaStopStep":             "Stop/Step",
		"gaPosition":             "Position",
		"gaPositionStatus":       "Position status",
		// Findings (short; the app has the full texts).
		"f-need_unconnected":            "not completely connected",
		"f-address_duplicate":           "address %{address} is used more than once",
		"f-address_outside_line":        "address %{address} is outside its line (%{prefix})",
		"f-bus_line_address_invalid":    "the line address %{address} cannot be read",
		"f-bus_line_address_duplicate":  "%{count} lines use the line address %{prefix}",
		"f-address_device_zero":         "address %{address} uses device 0, which is reserved for the line coupler",
		"f-bus_line_no_power_supply":    "the line has no power supply",
		"f-bus_line_current_exceeded":   "the bus current exceeds the supply",
		"f-bus_line_current_reserve":    "the bus current is within the reserve",
		"f-bus_line_devices_exceeded":   "more devices than the line takes",
		"f-bus_line_devices_reserve":    "the device count is within the reserve",
		"f-bus_device_unassigned":       "bus device without line",
		"f-wireless_no_gateway":         "wireless device without gateway",
		"f-gateway_places_exceeded":     "more devices than the gateway takes",
		"f-gateway_places_reserve":      "the gateway's places are within the reserve",
		"f-gateway_no_router":           "many devices and no router",
		"f-board_over_capacity":         "the modules exceed the board's capacity",
		"f-board_row_over_capacity":     "the modules exceed the row's capacity",
		"f-channel_overload_w":          "channel overloaded (W)",
		"f-channel_overload_a":          "channel overloaded (A)",
		"f-module_overload_w":           "module total overloaded (W)",
		"f-module_overload_a":           "module total overloaded (A)",
		"f-network_assignment_dangling": "the assigned line or gateway no longer applies",
		"f-units_exceeded":              "more units connected than the need has",
		"f-need_not_found":              "a connection belongs to a need that no longer exists",
		"f-target_not_found":            "connected to a device that no longer exists",
		"f-channel_not_found":           "connected to a channel the device no longer has",
		"f-function_not_served":         "the channel cannot serve this function",
		"f-motor_mismatch":              "the motor type does not match the channel",
		"f-channel_conflict":            "the channel's outputs are used twice",
		"f-circuit_not_allowed":         "several units on one channel, but they may not share a circuit",
		"f-bus_current_unknown":         "bus current unknown",
		"f-min_load":                    "below the channel's minimum load",
		"f-power_unknown":               "power unknown: limits not checked",
		"f-limit_unknown":               "limit unknown for this load type",
	},
	"de": {
		"manualTitle":                   "Installationshandbuch",
		"manualIntro":                   "Erstellt aus den Planungsdaten dieser Version: Verteiler, Kanäle, Anschlüsse, Adressen und die offenen Prüfergebnisse. Preise sind nicht Teil dieses Dokuments.",
		"labelsTitle":                   "Kanalbeschriftung",
		"labelsIntro":                   "Ein Streifen je Verteilerreihe mit 17,5 mm je Teilungseinheit (TE), 15 mm hoch; entlang der gestrichelten Linien schneiden. Je Kanal: Nummer, Zone, Bedarf; „1+2“: zwei Kanäle als einer genutzt; „–“: frei.",
		"teRange":                       "TE %d–%d",
		"number":                        "Dokument-Nr.",
		"date":                          "Datum",
		"project":                       "Projekt",
		"version":                       "Version",
		"page":                          "Seite {page} von {pages}",
		"overview":                      "Übersicht",
		"busLines":                      "Buslinien",
		"gateways":                      "Gateways",
		"openFindings":                  "Offene Prüfergebnisse",
		"noFindings":                    "Keine offenen Fehler oder Warnungen.",
		"noCables":                      "Kabel und Klemmen werden in SnapFlow nicht geplant; bitte vor Ort planen.",
		"enclosure":                     "Gehäuse",
		"row":                           "Reihe %d",
		"modules":                       "Module",
		"channels":                      "Kanäle",
		"freeChannels":                  "Freie Kanäle",
		"noFreeChannels":                "Keine.",
		"noModules":                     "Der Verteiler hat keine Module.",
		"noBoards":                      "Die Version hat keine Verteiler.",
		"zonesOf":                       "%s – Geräte und Bedarfe",
		"noZone":                        "Ohne Zone",
		"device":                        "Gerät",
		"existingMark":                  "vorhanden",
		"circuitMark":                   "Stromkreis",
		"notConnected":                  "%d nicht angeschlossen",
		"planLegend":                    "Buchstaben: Geräte, nummerierte Kreise: Bedarfe (beide in den Zonentabellen erklärt). Schraffiert: vorhandene Geräte.",
		"colMark":                       "Zeichen",
		"defaultMark":                   "Standard",
		"colLine":                       "Linie",
		"colSystem":                     "System",
		"colPrefix":                     "Adresse",
		"colSupplies":                   "Spannungsversorgungen",
		"colCurrent":                    "Strom genutzt / geliefert",
		"colDevices":                    "Geräte",
		"colGateway":                    "Gateway",
		"colLocation":                   "Ort",
		"colPlaces":                     "Plätze genutzt / verfügbar",
		"colSeverity":                   "Schwere",
		"colFinding":                    "Ergebnis",
		"colPos":                        "Pos.",
		"colRow":                        "Reihe",
		"colLabel":                      "Bezeichnung",
		"colProduct":                    "Produkt",
		"colModel":                      "Modell",
		"colTE":                         "TE",
		"colAddress":                    "Adresse",
		"colChannel":                    "Kanal",
		"colZone":                       "Zone",
		"colNeed":                       "Bedarf",
		"colLoad":                       "Last",
		"colCircuit":                    "Stromkreis",
		"colDevice":                     "Gerät",
		"colNetwork":                    "Linie / Gateway",
		"colNo":                         "Nr.",
		"colConnected":                  "Angeschlossen an",
		"colSubnet":                     "Subnetz",
		"colDeviceID":                   "Geräte-ID",
		"colChannels":                   "Kanäle und Lasten",
		"colNote":                       "Notiz",
		"colExisting":                   "Vorhanden",
		"colIEEE":                       "IEEE-Adresse",
		"yes":                           "ja",
		"noDevices":                     "Keine Geräte",
		"severity-error":                "Fehler",
		"severity-warning":              "Warnung",
		"severity-info":                 "Hinweis",
		"fileGroupAddresses":            "KNX-Gruppenadressen",
		"file-hdl-commissioning":        "HDL-Inbetriebnahmeliste",
		"file-wireless-devices":         "Funk-Geräteliste (EUI-64)",
		"sheetWithoutLine":              "Ohne Linie",
		"sheetWithoutGateway":           "Ohne Gateway",
		"file-knx-devices":              "KNX-Geräteliste",
		"gaSwitch":                      "Schalten",
		"gaSwitchStatus":                "Status Schalten",
		"gaDimRelative":                 "Dimmen relativ",
		"gaBrightness":                  "Helligkeitswert",
		"gaBrightnessStatus":            "Status Helligkeit",
		"gaUpDown":                      "Auf/Ab",
		"gaStopStep":                    "Stopp/Lamelle",
		"gaPosition":                    "Position",
		"gaPositionStatus":              "Status Position",
		"f-need_unconnected":            "nicht vollständig angeschlossen",
		"f-address_duplicate":           "Adresse %{address} ist mehrfach vergeben",
		"f-address_outside_line":        "Adresse %{address} liegt außerhalb ihrer Linie (%{prefix})",
		"f-bus_line_address_invalid":    "die Linienadresse %{address} ist nicht lesbar",
		"f-bus_line_address_duplicate":  "%{count} Linien nutzen die Linienadresse %{prefix}",
		"f-address_device_zero":         "Adresse %{address} nutzt Gerät 0, das dem Linienkoppler vorbehalten ist",
		"f-bus_line_no_power_supply":    "die Linie hat keine Spannungsversorgung",
		"f-bus_line_current_exceeded":   "der Busstrom übersteigt die Versorgung",
		"f-bus_line_current_reserve":    "der Busstrom liegt in der Reserve",
		"f-bus_line_devices_exceeded":   "mehr Geräte als die Linie aufnimmt",
		"f-bus_line_devices_reserve":    "die Geräteanzahl liegt in der Reserve",
		"f-bus_device_unassigned":       "Busgerät ohne Linie",
		"f-wireless_no_gateway":         "Funkgerät ohne Gateway",
		"f-gateway_places_exceeded":     "mehr Geräte als das Gateway aufnimmt",
		"f-gateway_places_reserve":      "die Plätze des Gateways liegen in der Reserve",
		"f-gateway_no_router":           "viele Geräte und kein Router",
		"f-board_over_capacity":         "die Module übersteigen die Kapazität des Verteilers",
		"f-board_row_over_capacity":     "die Module übersteigen die Kapazität der Reihe",
		"f-channel_overload_w":          "Kanal überlastet (W)",
		"f-channel_overload_a":          "Kanal überlastet (A)",
		"f-module_overload_w":           "Modul gesamt überlastet (W)",
		"f-module_overload_a":           "Modul gesamt überlastet (A)",
		"f-network_assignment_dangling": "die zugewiesene Linie oder das Gateway gilt nicht mehr",
		"f-units_exceeded":              "mehr Einheiten angeschlossen als der Bedarf hat",
		"f-need_not_found":              "ein Anschluss gehört zu einem Bedarf, den es nicht mehr gibt",
		"f-target_not_found":            "an ein Gerät angeschlossen, das es nicht mehr gibt",
		"f-channel_not_found":           "an einen Kanal angeschlossen, den das Gerät nicht mehr hat",
		"f-function_not_served":         "der Kanal kann diese Funktion nicht bedienen",
		"f-motor_mismatch":              "die Motorart passt nicht zum Kanal",
		"f-channel_conflict":            "die Ausgänge des Kanals sind doppelt belegt",
		"f-circuit_not_allowed":         "mehrere Einheiten an einem Kanal, die keinen Stromkreis teilen dürfen",
		"f-bus_current_unknown":         "Busstrom unbekannt",
		"f-min_load":                    "unter der Mindestlast des Kanals",
		"f-power_unknown":               "Leistung unbekannt: Grenzen nicht geprüft",
		"f-limit_unknown":               "Grenze für diese Lastart unbekannt",
	},
}

var months = map[string][]string{
	"en": {"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"},
	"de": {"Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"},
}

// tr is a content language.
type tr string

func (l tr) norm() tr {
	if _, ok := messages[string(l)]; ok {
		return l
	}
	return "en"
}

// t is the text of key, formatted with args.
func (l tr) t(key string, args ...any) string {
	s, ok := messages[string(l.norm())][key]
	if !ok {
		s, ok = messages["en"][key]
	}
	if !ok {
		s = key
	}
	if len(args) > 0 {
		return fmt.Sprintf(s, args...)
	}
	return s
}

// finding is a short text of a checks code with its params ("%{name}"
// placeholders); unknown codes show the code.
func (l tr) finding(code string, params map[string]any) string {
	s, ok := messages[string(l.norm())]["f-"+code]
	if !ok {
		s, ok = messages["en"]["f-"+code]
	}
	if !ok {
		return strings.ReplaceAll(code, "_", " ")
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		s = strings.ReplaceAll(s, "%{"+k+"}", fmt.Sprint(params[k]))
	}
	return s
}

func (l tr) date(t time.Time) string {
	if l.norm() == "de" {
		return fmt.Sprintf("%d. %s %d", t.Day(), months["de"][t.Month()-1], t.Year())
	}
	return fmt.Sprintf("%d %s %d", t.Day(), months["en"][t.Month()-1], t.Year())
}

// num formats a number without trailing zeros, with the language's
// decimal separator.
func (l tr) num(v float64) string {
	s := strconv.FormatFloat(v, 'f', -1, 64)
	if i := strings.IndexByte(s, '.'); i >= 0 && len(s)-i > 3 {
		s = strconv.FormatFloat(v, 'f', 2, 64)
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	if l.norm() == "de" {
		s = strings.ReplaceAll(s, ".", ",")
	}
	return s
}

// watts formats a decimal string of watts ("60.00" → "60 W").
func (l tr) watts(s string) string {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s + " W"
	}
	return l.num(v) + " W"
}
