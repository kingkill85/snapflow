package installation

// KNX group addresses (3e, D422): generated, not stored, from the needs
// connected to channels of KNX items. Three levels: main = floorplan,
// middle = zone, sub = the communication objects of each need's function.

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// KNX 3-level ranges: main 0-31, middle 0-7, sub 0-255.
const (
	maxMain   = 31
	maxMiddle = 7
	maxSub    = 255
	// firstMain: main group 0 is left for central functions.
	firstMain = 1
)

// gaObject is one communication object of a function.
type gaObject struct {
	key string // message key of the object name
	dpt string // ETS datapoint subtype notation
}

// objectsOf are the group objects of a function type, by its key (D422):
// dimming (key contains "dimm"), blinds (blind, curtain, shutter, shade,
// motor), inputs (input, sensor, button: one switching object), else
// switching.
func objectsOf(key string) []gaObject {
	k := strings.ToLower(key)
	has := func(parts ...string) bool {
		for _, p := range parts {
			if strings.Contains(k, p) {
				return true
			}
		}
		return false
	}
	switch {
	case has("dimm"):
		return []gaObject{{"gaSwitch", "DPST-1-1"}, {"gaSwitchStatus", "DPST-1-1"}, {"gaDimRelative", "DPST-3-7"},
			{"gaBrightness", "DPST-5-1"}, {"gaBrightnessStatus", "DPST-5-1"}}
	case has("blind", "curtain", "shutter", "shade", "motor", "jalousie", "rollo"):
		return []gaObject{{"gaUpDown", "DPST-1-8"}, {"gaStopStep", "DPST-1-7"}, {"gaPosition", "DPST-5-1"}, {"gaPositionStatus", "DPST-5-1"}}
	case has("input", "sensor", "button", "push"):
		return []gaObject{{"gaSwitch", "DPST-1-1"}}
	}
	return []gaObject{{"gaSwitch", "DPST-1-1"}, {"gaSwitchStatus", "DPST-1-1"}}
}

// GroupAddress is one row of the group address list: a main group, a
// middle group or a group address (sub).
type GroupAddress struct {
	Level       int // 1 main, 2 middle, 3 sub
	Main        int
	Middle      int
	Sub         int
	Name        string
	Description string
	DPT         string
}

// Address in 3-level notation with "-" for the missing levels.
func (g GroupAddress) Address() string {
	switch g.Level {
	case 1:
		return fmt.Sprintf("%d/-/-", g.Main)
	case 2:
		return fmt.Sprintf("%d/%d/-", g.Main, g.Middle)
	}
	return fmt.Sprintf("%d/%d/%d", g.Main, g.Middle, g.Sub)
}

// groupAddresses generates the group addresses (D422): floorplans in plan
// order take main groups from 1; the zones of a plan in zone order take
// middle groups 0-7 (needs outside zones after the last zone); a plan with
// more than 8 zones continues in the next main group. Within a zone the
// needs in need order take consecutive sub addresses from 1, one per object
// of their function. Only needs with a connection to a KNX item count, but
// every zone keeps its middle group, so numbers stay when needs change.
func groupAddresses(d *data) ([]GroupAddress, error) {
	knx := map[[2]uuid.UUID]bool{}
	for _, a := range d.addresses.Items {
		if a.Scheme == networks.SchemeKNX {
			knx[[2]uuid.UUID{a.PlanID, a.ItemID}] = true
		}
	}
	onKNX := map[[2]uuid.UUID][]wiring.Connection{}
	for _, c := range d.wiring.Connections {
		if knx[[2]uuid.UUID{c.TargetPlanID, c.TargetItemID}] {
			k := [2]uuid.UUID{c.NeedPlanID, c.NeedID}
			onKNX[k] = append(onKNX[k], c)
		}
	}
	var out []GroupAddress
	main := firstMain
	for _, p := range d.plans {
		if p.Kind != "floorplan" {
			continue
		}
		// Zones of the plan in order (the checks list them so), then
		// needs outside zones.
		type zone struct {
			id   *uuid.UUID
			name string
		}
		var zones []zone
		for _, z := range d.checks.Zones {
			if z.PlanID == p.ID {
				zones = append(zones, zone{z.ZoneID, z.Name})
			}
		}
		if !hasNilZone(zones, func(z zone) *uuid.UUID { return z.id }) {
			zones = append(zones, zone{nil, d.lang.t("noZone")})
		}
		chunks := (len(zones) + maxMiddle) / (maxMiddle + 1)
		for zi, z := range zones {
			m, middle := main+zi/(maxMiddle+1), zi%(maxMiddle+1)
			if m > maxMain {
				return nil, apperr.New(http.StatusUnprocessableEntity, "export.too_many_group_addresses", "more floors and zones than KNX main groups").
					With("max", maxMain)
			}
			if z.name == "" {
				z.name = d.lang.t("noZone")
			}
			var subs []GroupAddress
			sub := 1
			for _, n := range d.wiring.Needs {
				if n.PlanID != p.ID || !sameZone(n.ZoneID, z.id) {
					continue
				}
				conns := onKNX[[2]uuid.UUID{n.PlanID, n.NeedID}]
				if len(conns) == 0 {
					continue
				}
				var targets []string
				for _, c := range conns {
					targets = append(targets, d.itemName(d.item(c.TargetPlanID, c.TargetItemID))+" "+d.channelText(c.OutputKindID, c.ChannelNo))
				}
				key := ""
				if f, ok := d.functions[n.FunctionTypeID]; ok {
					key = f.Key
				}
				for _, o := range objectsOf(key) {
					if sub > maxSub {
						return nil, apperr.New(http.StatusUnprocessableEntity, "export.too_many_group_addresses", "more group addresses in a zone than KNX allows").
							With("zone", z.name).With("max", maxSub)
					}
					subs = append(subs, GroupAddress{Level: 3, Main: m, Middle: middle, Sub: sub,
						Name: z.name + " " + d.needName(&n) + " " + d.lang.t(o.key), Description: strings.Join(targets, ", "), DPT: o.dpt})
					sub++
				}
			}
			if len(subs) == 0 {
				continue
			}
			if !containsMain(out, m) {
				name := p.Name
				if chunks > 1 {
					name = fmt.Sprintf("%s (%d)", p.Name, zi/(maxMiddle+1)+1)
				}
				out = append(out, GroupAddress{Level: 1, Main: m, Name: name})
			}
			out = append(out, GroupAddress{Level: 2, Main: m, Middle: middle, Name: z.name})
			out = append(out, subs...)
		}
		main += max(chunks, 1)
	}
	return out, nil
}

func containsMain(gs []GroupAddress, m int) bool {
	for _, g := range gs {
		if g.Level == 1 && g.Main == m {
			return true
		}
	}
	return false
}

func hasNilZone[T any](zs []T, id func(T) *uuid.UUID) bool {
	for _, z := range zs {
		if id(z) == nil {
			return true
		}
	}
	return false
}

func sameZone(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// groupAddressCSV writes the ETS group address import file (D422): UTF-8
// with BOM, CRLF line ends, comma separated, every field quoted ("" inside
// a field doubled), the ETS "3/1" layout: the header
// "Main","Middle","Sub","Address","Central","Unfiltered","Description","DatapointType","Security";
// a main group row has its name in Main and the address "m/-/-", a middle
// group row its name in Middle and "m/n/-", a group address its name in Sub
// and "m/n/s"; Central and Unfiltered empty, Security "Auto".
func groupAddressCSV(gs []GroupAddress) []byte {
	var b bytes.Buffer
	b.WriteString("\ufeff")
	row := func(fields ...string) {
		for i, f := range fields {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(`"` + strings.ReplaceAll(f, `"`, `""`) + `"`)
		}
		b.WriteString("\r\n")
	}
	row("Main", "Middle", "Sub", "Address", "Central", "Unfiltered", "Description", "DatapointType", "Security")
	for _, g := range gs {
		switch g.Level {
		case 1:
			row(g.Name, "", "", g.Address(), "", "", "", "", "Auto")
		case 2:
			row("", g.Name, "", g.Address(), "", "", "", "", "Auto")
		default:
			row("", "", g.Name, g.Address(), "", "", g.Description, g.DPT, "Auto")
		}
	}
	return b.Bytes()
}

// Export is a generated file.
type Export struct {
	FileName    string
	ContentType string
	Data        []byte
}

// GroupAddressesCSV exports the KNX group addresses of a version.
func (s *Service) GroupAddressesCSV(ctx context.Context, versionID uuid.UUID) (Export, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Export{}, err
	}
	d, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Export{}, err
	}
	gs, err := groupAddresses(d)
	if err != nil {
		return Export{}, err
	}
	return Export{FileName: exportName(d, d.lang.t("fileGroupAddresses"), "csv"), ContentType: "text/csv; charset=utf-8", Data: groupAddressCSV(gs)}, nil
}

// exportName: "<project number>-<version> <what> <project name>.<ext>".
func exportName(d *data, what, ext string) string {
	return proposals.FileName(d.project.Number+"-"+d.version.Name+" "+what, d.project.Name, ext)
}
