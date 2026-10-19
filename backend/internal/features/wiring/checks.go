package wiring

// The checks engine (spec 3d): evaluates a whole version on demand from one
// load of its inputs, in memory, deterministically.

import (
	"context"
	"slices"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Codes of the checks besides the validity codes.
const (
	CodeNeedUnconnected        = "need_unconnected"
	CodeBusLineNoPowerSupply   = "bus_line_no_power_supply"
	CodeBusLineCurrentHigh     = "bus_line_current_reserve"
	CodeBusLineCurrentOver     = "bus_line_current_exceeded"
	CodeBusLineDevicesHigh     = "bus_line_devices_reserve"
	CodeBusLineDevicesOver     = "bus_line_devices_exceeded"
	CodeBusCurrentUnknown      = "bus_current_unknown"
	CodeBusDeviceUnassigned    = "bus_device_unassigned"
	CodeWirelessNoGateway      = "wireless_no_gateway"
	CodeGatewayPlacesHigh      = "gateway_places_reserve"
	CodeGatewayPlacesOver      = "gateway_places_exceeded"
	CodeGatewayNoRouter        = "gateway_no_router"
	CodeBoardOverCapacity      = "board_over_capacity"
	CodeBoardRowOverCapacity   = "board_row_over_capacity"
	CodeAssignmentDangling     = "network_assignment_dangling"
	RouterThreshold            = 20
	defaultBoardReservePercent = 20
)

// statusOf rates used against supplied with a reserve: red when exceeded,
// amber above 100 − reserve %, unknown without supply.
func statusOf(used, supplied float64, reserve int32) Status {
	switch {
	case supplied <= 0:
		return StatusUnknown
	case used > supplied+1e-9:
		return StatusRed
	case used > supplied*float64(100-reserve)/100+1e-9:
		return StatusAmber
	}
	return StatusOK
}

func findingOf(st *state, p Problem) Finding {
	f := Finding{Severity: p.Severity, Code: p.Code, Params: p.Params, Refs: Refs{ConnectionIDs: p.Conns}}
	if f.Params == nil {
		f.Params = map[string]any{}
	}
	if p.Need != nil {
		pl, id := p.Need.PlanID, p.Need.ID
		f.Refs.PlanID, f.Refs.NeedID = &pl, &id
	}
	if p.Channel != nil {
		pl, it, k, no := p.Channel.Item.PlanID, p.Channel.Item.ID, p.Channel.Kind, st.noOf(*p.Channel, 0)
		f.Refs.TargetPlanID, f.Refs.ItemID, f.Refs.OutputKindID, f.Refs.ChannelNo = &pl, &it, &k, &no
	}
	if p.Item != nil {
		pl, it := p.Item.PlanID, p.Item.ID
		f.Refs.TargetPlanID, f.Refs.ItemID = &pl, &it
	}
	return f
}

// itemFinding is a finding about an item, named by its label and product
// (D412).
func itemFinding(st *state, sev Severity, code string, planID, itemID uuid.UUID, params map[string]any) Finding {
	if it := st.items[ItemKey{planID, itemID}]; it != nil {
		params = itemParams(it, params)
	}
	return Finding{Severity: sev, Code: code, Refs: Refs{TargetPlanID: &planID, ItemID: &itemID}, Params: params}
}

// Checks evaluates a version.
func (s *Service) Checks(ctx context.Context, versionID uuid.UUID) (Checks, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Checks{}, err
	}
	sn, err := s.read(ctx, actor, versionID)
	if err != nil {
		return Checks{}, err
	}
	members, err := s.networks.Membership(ctx, versionID)
	if err != nil {
		return Checks{}, err
	}
	lines, err := s.networks.ListBusLines(ctx, versionID)
	if err != nil {
		return Checks{}, err
	}
	return evaluateChecks(sn, members, lines), nil
}

// evaluateChecks is the pure part of Checks.
func evaluateChecks(sn *snapshot, members []networks.Member, lines []networks.BusLine) Checks {
	st := sn.st
	out := Checks{VersionID: sn.ref.ID, Zones: []ZoneStatus{}, Boards: []BoardStatus{}, BusLines: []BusLineStatus{}, Gateways: []GatewayStatus{},
		Findings: []Finding{}}
	var findings []Finding

	// Connection validity (dangling, overloads, circuits, limits); zones
	// count only connections without errors (D412).
	broken := map[uuid.UUID]bool{}
	for _, p := range st.evaluate() {
		findings = append(findings, findingOf(st, p))
		if p.Severity == SeverityError {
			for _, id := range p.Conns {
				broken[id] = true
			}
		}
	}

	// Zones and unconnected needs.
	for _, p := range sn.data.Plans {
		if p.Kind != "floorplan" {
			continue
		}
		type acc struct{ units, connected int64 }
		byZone := map[uuid.UUID]*acc{}
		var none *acc
		zoneExists := map[uuid.UUID]bool{}
		for _, z := range p.Zones {
			zoneExists[z.ID] = true
		}
		for _, n := range p.Needs {
			k := NeedKey{p.ID, n.ID}
			// connected: every connection (need_unconnected); good: only
			// those without errors (zone coverage, D412).
			connected, good := int64(0), int64(0)
			for _, c := range st.byNeed[k] {
				connected += int64(c.Units)
				if !broken[c.ID] {
					good += int64(c.Units)
				}
			}
			connected = min(connected, int64(n.Quantity))
			good = min(good, int64(n.Quantity))
			a := none
			if n.ZoneID != nil {
				a = byZone[*n.ZoneID]
				if a == nil {
					a = &acc{}
					byZone[*n.ZoneID] = a
				}
			} else {
				if none == nil {
					none = &acc{}
				}
				a = none
			}
			a.units += int64(n.Quantity)
			a.connected += good
			out.Counts.Units += int64(n.Quantity)
			out.Counts.ConnectedUnits += good
			if missing := int64(n.Quantity) - connected; missing > 0 {
				pl, id := p.ID, n.ID
				// A need of a zone that no longer exists links to the plan.
				var zone *uuid.UUID
				if n.ZoneID != nil && zoneExists[*n.ZoneID] {
					zone = n.ZoneID
				}
				f := Finding{Severity: SeverityWarning, Code: CodeNeedUnconnected, Refs: Refs{PlanID: &pl, NeedID: &id, ZoneID: zone},
					Params: map[string]any{"missing": missing, "quantity": n.Quantity, "functionTypeKey": st.cat.FunctionKey[n.FunctionTypeID], "label": n.Label}}
				findings = append(findings, f)
			}
		}
		zone := func(id *uuid.UUID, name string, a *acc) {
			z := ZoneStatus{PlanID: p.ID, ZoneID: id, Name: name, Status: "none"}
			if a != nil && a.units > 0 {
				z.Units, z.ConnectedUnits = a.units, a.connected
				out.Counts.ZonesWithNeeds++
				switch {
				case a.connected >= a.units:
					z.Status = "covered"
					out.Counts.ZonesCovered++
				case a.connected > 0:
					z.Status = "partial"
				default:
					z.Status = "missing"
				}
			}
			out.Zones = append(out.Zones, z)
		}
		known := map[uuid.UUID]bool{}
		for _, z := range p.Zones {
			id := z.ID
			known[id] = true
			zone(&id, z.Name, byZone[id])
		}
		// Needs of a zone removed meanwhile count as outside every zone.
		for _, n := range p.Needs {
			if n.ZoneID != nil && !known[*n.ZoneID] {
				if a := byZone[*n.ZoneID]; a != nil {
					if none == nil {
						none = &acc{}
					}
					none.units += a.units
					none.connected += a.connected
					delete(byZone, *n.ZoneID)
				}
			}
		}
		if none != nil {
			zone(nil, "", none)
		}
	}

	// Boards: channels per kind (alternatives), TE per row.
	for _, p := range sn.data.Plans {
		if p.Kind != "board" {
			continue
		}
		b := BoardStatus{PlanID: p.ID, Name: p.Name, Channels: []ChannelUse{}, Rows: []RowUse{}}
		rowUse := map[uuid.UUID]float64{}
		native := map[uuid.UUID]*ChannelUse{}
		alt := map[uuid.UUID]*ChannelUse{}
		for _, m := range p.Modules {
			it := st.items[ItemKey{p.ID, m.ID}]
			w := 1.0
			if it.HasVariant && it.Caps.RailWidthTE != nil {
				w = *it.Caps.RailWidthTE
			}
			rowUse[m.RowID] += w
			for _, c := range it.Caps.Channels {
				u := native[c.OutputKindID]
				if u == nil {
					u = &ChannelUse{OutputKindID: c.OutputKindID, OutputKindKey: st.cat.KindKey[c.OutputKindID]}
					native[c.OutputKindID] = u
				}
				u.Total += c.Count
				for no := 1; no <= c.Count; no++ {
					if len(st.phys[physKey{it.Key, c.OutputKindID, no}]) > 0 {
						u.Used++
					}
				}
			}
			// Alternatives: groups possible, used, and free (all base
			// channels free).
			for _, c := range it.Caps.Channels {
				for _, a := range c.Alternatives {
					u := alt[a.OutputKindID]
					if u == nil {
						u = &ChannelUse{OutputKindID: a.OutputKindID, OutputKindKey: st.cat.KindKey[a.OutputKindID], Alternative: true}
						alt[a.OutputKindID] = u
					}
					u.Total += a.Max
				}
			}
			for _, k := range sn.facts.kinds {
				u := alt[k.ID]
				if u == nil {
					continue
				}
				for _, ch := range kindChannels(it, k.ID) {
					if !ch.Alternative() {
						continue
					}
					switch {
					case len(st.byChannel[ch]) > 0:
						u.Used++
					case !st.busy(ch):
						u.Free++
					}
				}
			}
		}
		for _, k := range sn.facts.kinds {
			if u := native[k.ID]; u != nil {
				u.Free = u.Total - u.Used
				b.Channels = append(b.Channels, *u)
			}
		}
		for _, k := range sn.facts.kinds {
			if u := alt[k.ID]; u != nil {
				b.Channels = append(b.Channels, *u)
			}
		}
		// Each row on its own: modules cannot overflow into another row
		// (D412).
		for i, r := range p.Rows {
			used := float64(int(rowUse[r.ID]*10+0.5)) / 10
			ru := RowUse{RowID: r.ID, Position: r.Position, UsedTE: used, CapacityTE: r.CapacityTE,
				Status: statusOf(used, r.CapacityTE, defaultBoardReservePercent)}
			if used > r.CapacityTE+1e-9 {
				ru.Status = StatusRed
				pl := p.ID
				findings = append(findings, Finding{Severity: SeverityError, Code: CodeBoardRowOverCapacity, Refs: Refs{TargetPlanID: &pl},
					Params: map[string]any{"name": p.Name, "row": i + 1, "usedTe": used, "capacityTe": r.CapacityTE}})
			}
			b.Rows = append(b.Rows, ru)
			b.UsedTE += used
			b.CapacityTE += r.CapacityTE
		}
		b.Status = statusOf(b.UsedTE, b.CapacityTE, defaultBoardReservePercent)
		if b.Status == StatusRed {
			pl := p.ID
			findings = append(findings, Finding{Severity: SeverityError, Code: CodeBoardOverCapacity, Refs: Refs{TargetPlanID: &pl},
				Params: map[string]any{"name": p.Name, "usedTe": b.UsedTE, "capacityTe": b.CapacityTE}})
		}
		out.Boards = append(out.Boards, b)
	}

	// Bus lines and gateways (membership, D372).
	itemOf := func(m networks.Member) *Item { return st.items[ItemKey{m.PlanID, m.ItemID}] }
	lineIndex := map[uuid.UUID]int{}
	for _, l := range lines {
		t := sn.facts.types[l.ProductTypeID]
		ls := BusLineStatus{BusLineID: l.ID, Name: l.Name, ProductTypeID: l.ProductTypeID, ReservePercent: t.ReservePercent, DevicesMax: l.DevicesMax}
		if ls.DevicesMax == nil {
			ls.DevicesMax = t.BusDevicesMax
		}
		lineIndex[l.ID] = len(out.BusLines)
		out.BusLines = append(out.BusLines, ls)
	}
	gwIndex := map[ItemKey]int{}
	for _, m := range members {
		it := itemOf(m)
		if it == nil || !m.Gateway {
			continue
		}
		t := sn.facts.types[m.SystemID]
		g := GatewayStatus{PlanID: m.PlanID, ItemID: m.ItemID, Label: it.Label, ProductTypeID: m.SystemID, ReservePercent: t.ReservePercent}
		if it.Caps.WirelessPlacesSupplied != nil {
			g.PlacesSupplied = *it.Caps.WirelessPlacesSupplied
		}
		gwIndex[it.Key] = len(out.Gateways)
		out.Gateways = append(out.Gateways, g)
	}
	for _, m := range members {
		it := itemOf(m)
		if it == nil {
			continue
		}
		c := it.Caps
		if m.Dangling != "" {
			findings = append(findings, itemFinding(st, SeverityWarning, CodeAssignmentDangling, m.PlanID, m.ItemID,
				map[string]any{"kind": m.Dangling}))
		}
		switch {
		case m.Topology == networks.TopologyBus:
			if m.LineID == nil {
				findings = append(findings, itemFinding(st, SeverityWarning, CodeBusDeviceUnassigned, m.PlanID, m.ItemID, map[string]any{}))
				continue
			}
			i, ok := lineIndex[*m.LineID]
			if !ok {
				continue
			}
			l := &out.BusLines[i]
			l.Devices++
			psu := c.BusCurrentSuppliedMa != nil && *c.BusCurrentSuppliedMa > 0
			if psu {
				l.CurrentSuppliedMa += *c.BusCurrentSuppliedMa
			}
			switch {
			case c.BusCurrentUsedMa != nil:
				l.CurrentUsedMa += *c.BusCurrentUsedMa
				if c.BusCurrentUsedMaDefault {
					l.CurrentDefaultMa += *c.BusCurrentUsedMa
				}
			case !psu:
				l.UnknownCurrentCount++
				f := itemFinding(st, SeverityWarning, CodeBusCurrentUnknown, m.PlanID, m.ItemID, map[string]any{})
				id := *m.LineID
				f.Refs.BusLineID = &id
				findings = append(findings, f)
			}
		case m.Topology == networks.TopologyWireless && !m.Gateway:
			if m.GatewayPlanID == nil {
				findings = append(findings, itemFinding(st, SeverityWarning, CodeWirelessNoGateway, m.PlanID, m.ItemID, map[string]any{}))
				continue
			}
			i, ok := gwIndex[ItemKey{*m.GatewayPlanID, *m.GatewayItemID}]
			if !ok {
				continue
			}
			g := &out.Gateways[i]
			g.Devices++
			if c.ZigbeeRouter != nil && *c.ZigbeeRouter {
				g.Routers++
			}
			if c.WirelessPlacesUsed != nil {
				g.PlacesUsed += *c.WirelessPlacesUsed
			} else {
				g.UnknownCount++
			}
		}
	}
	for i := range out.BusLines {
		l := &out.BusLines[i]
		id := l.BusLineID
		ref := Refs{BusLineID: &id}
		l.CurrentStatus = statusOf(l.CurrentUsedMa, l.CurrentSuppliedMa, l.ReservePercent)
		params := map[string]any{"usedMa": l.CurrentUsedMa, "suppliedMa": l.CurrentSuppliedMa, "reservePercent": l.ReservePercent, "name": l.Name}
		switch {
		case l.Devices > 0 && l.CurrentSuppliedMa <= 0:
			findings = append(findings, Finding{Severity: SeverityError, Code: CodeBusLineNoPowerSupply, Refs: ref, Params: map[string]any{"name": l.Name}})
		case l.CurrentStatus == StatusRed:
			findings = append(findings, Finding{Severity: SeverityError, Code: CodeBusLineCurrentOver, Refs: ref, Params: params})
		case l.CurrentStatus == StatusAmber:
			findings = append(findings, Finding{Severity: SeverityWarning, Code: CodeBusLineCurrentHigh, Refs: ref, Params: params})
		}
		l.DevicesStatus = StatusUnknown
		if l.DevicesMax != nil {
			l.DevicesStatus = statusOf(float64(l.Devices), float64(*l.DevicesMax), l.ReservePercent)
			dp := map[string]any{"devices": l.Devices, "max": *l.DevicesMax, "reservePercent": l.ReservePercent, "name": l.Name}
			switch l.DevicesStatus {
			case StatusRed:
				findings = append(findings, Finding{Severity: SeverityError, Code: CodeBusLineDevicesOver, Refs: ref, Params: dp})
			case StatusAmber:
				findings = append(findings, Finding{Severity: SeverityWarning, Code: CodeBusLineDevicesHigh, Refs: ref, Params: dp})
			}
		}
	}
	for i := range out.Gateways {
		g := &out.Gateways[i]
		g.Status = statusOf(g.PlacesUsed, g.PlacesSupplied, g.ReservePercent)
		params := map[string]any{"used": g.PlacesUsed, "supplied": g.PlacesSupplied, "reservePercent": g.ReservePercent, "label": g.Label}
		switch g.Status {
		case StatusRed:
			findings = append(findings, itemFinding(st, SeverityError, CodeGatewayPlacesOver, g.PlanID, g.ItemID, params))
		case StatusAmber:
			findings = append(findings, itemFinding(st, SeverityWarning, CodeGatewayPlacesHigh, g.PlanID, g.ItemID, params))
		}
		if g.Devices-g.Routers >= RouterThreshold && g.Routers == 0 {
			findings = append(findings, itemFinding(st, SeverityWarning, CodeGatewayNoRouter, g.PlanID, g.ItemID,
				map[string]any{"devices": g.Devices, "threshold": RouterThreshold, "label": g.Label}))
		}
	}

	// Errors, then warnings, then infos; otherwise in the order found.
	rank := map[Severity]int{SeverityError: 0, SeverityWarning: 1, SeverityInfo: 2}
	slices.SortStableFunc(findings, func(a, b Finding) int { return rank[a.Severity] - rank[b.Severity] })
	for _, f := range findings {
		switch f.Severity {
		case SeverityError:
			out.Counts.Errors++
		case SeverityWarning:
			out.Counts.Warnings++
		default:
			out.Counts.Infos++
		}
	}
	if findings != nil {
		out.Findings = findings
	}
	return out
}
