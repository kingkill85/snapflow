package installation

// Commissioning lists (3e, D423): one XLSX workbook per system kind, one
// sheet per bus line (KNX, HDL) or gateway (Zigbee), a row per device.

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// List kinds.
const (
	ListHDL    = "hdl-commissioning"
	ListZigbee = "zigbee-devices"
	ListKNX    = "knx-devices"
)

// sheet is one sheet of a list.
type sheet struct {
	name string
	rows [][]any
}

// location: a module "<board> D<n>", a device "<plan> · <zone>".
func (d *data) location(it *itemRef) string {
	if it.board {
		return it.planName + " " + it.position
	}
	if it.zoneID == nil {
		return it.planName
	}
	return it.planName + " · " + d.zoneName(it.planID, it.zoneID)
}

// channelLoads lists an item's connected channels: "Dimmer 1: Living
// Ceiling 3 × 60 W LED".
func (d *data) channelLoads(planID, itemID uuid.UUID) string {
	var parts []string
	for _, c := range d.wiring.Connections {
		if c.TargetPlanID != planID || c.TargetItemID != itemID {
			continue
		}
		n := d.needByKey[[2]uuid.UUID{c.NeedPlanID, c.NeedID}]
		if n == nil {
			continue
		}
		parts = append(parts, d.channelText(c.OutputKindID, c.ChannelNo)+": "+strings.TrimSpace(n.ZoneName+" "+d.needName(n))+" "+d.loadText(n, c.Units))
	}
	return strings.Join(parts, "; ")
}

// commissioning builds the sheets of a list.
func commissioning(d *data, kind string) []sheet {
	l := d.lang
	var out []sheet
	switch kind {
	case ListHDL, ListKNX:
		scheme := networks.SchemeHDL
		head := []any{l.t("colDevice"), l.t("colProduct"), l.t("colModel"), l.t("colLocation"), l.t("colSubnet"), l.t("colDeviceID"),
			l.t("colChannels"), l.t("colNote"), l.t("colExisting")}
		if kind == ListKNX {
			scheme = networks.SchemeKNX
			head = []any{l.t("colDevice"), l.t("colProduct"), l.t("colModel"), l.t("colLocation"), l.t("colAddress"), l.t("colChannels"),
				l.t("colNote"), l.t("colExisting")}
		}
		for _, sys := range d.networks.BusSystems {
			for _, line := range sys.Lines {
				if d.prefixByID[line.ID].Scheme != scheme {
					continue
				}
				sh := sheet{name: line.Name, rows: [][]any{head}}
				for _, a := range d.addresses.Items {
					if a.BusLineID == nil || *a.BusLineID != line.ID || a.PowerSupply {
						continue
					}
					it := d.item(a.PlanID, a.ItemID)
					note, existing := "", ""
					if a.Address != nil {
						note = a.Address.Note
					}
					if a.Existing {
						existing = l.t("yes")
					}
					row := []any{d.itemName(it), d.productName(&a.VariantID), a.ModelNumber, d.location(it)}
					if kind == ListHDL {
						subnet, dev := "", ""
						if a.Address != nil && a.Address.HDL != "" {
							subnet, dev, _ = strings.Cut(a.Address.HDL, ".")
						}
						row = append(row, numberOrText(subnet), numberOrText(dev))
					} else {
						row = append(row, addressText(a))
					}
					row = append(row, d.channelLoads(a.PlanID, a.ItemID), note, existing)
					sh.rows = append(sh.rows, row)
				}
				out = append(out, sh)
			}
		}
	case ListZigbee:
		head := []any{l.t("colDevice"), l.t("colProduct"), l.t("colModel"), l.t("colLocation"), l.t("colIEEE"), l.t("colChannels"),
			l.t("colNote"), l.t("colExisting")}
		for _, sys := range d.networks.WirelessSystems {
			byGateway := map[[2]uuid.UUID]*sheet{}
			var order []*sheet
			for _, g := range sys.Gateways {
				gw := d.item(g.PlanID, g.ItemID)
				sh := &sheet{name: d.itemName(gw), rows: [][]any{head}}
				byGateway[[2]uuid.UUID{g.PlanID, g.ItemID}] = sh
				order = append(order, sh)
			}
			for _, a := range d.addresses.Items {
				if a.SystemID != sys.ProductType.ID {
					continue
				}
				var sh *sheet
				switch {
				case a.Gateway:
					sh = byGateway[[2]uuid.UUID{a.PlanID, a.ItemID}]
				case a.GatewayItemID != nil:
					sh = byGateway[[2]uuid.UUID{*a.GatewayPlanID, *a.GatewayItemID}]
				}
				if sh == nil {
					continue
				}
				it := d.item(a.PlanID, a.ItemID)
				note, existing := "", ""
				if a.Address != nil {
					note = a.Address.Note
				}
				if a.Existing {
					existing = l.t("yes")
				}
				sh.rows = append(sh.rows, []any{d.itemName(it), d.productName(&a.VariantID), a.ModelNumber, d.location(it), addressText(a),
					d.channelLoads(a.PlanID, a.ItemID), note, existing})
			}
			for _, sh := range order {
				out = append(out, *sh)
			}
		}
	}
	return out
}

func numberOrText(s string) any {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return s
}

// workbook writes the sheets (names made unique and at most 31
// characters, without the characters Excel refuses).
func workbook(sheets []sheet, empty string) ([]byte, error) {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	used := map[string]bool{}
	first := ""
	for _, sh := range sheets {
		name := sheetName(sh.name, used)
		if first == "" {
			first = name
			if err := f.SetSheetName("Sheet1", name); err != nil {
				return nil, err
			}
		} else if _, err := f.NewSheet(name); err != nil {
			return nil, err
		}
		for i, r := range sh.rows {
			cell, _ := excelize.CoordinatesToCellName(1, i+1)
			if err := f.SetSheetRow(name, cell, &r); err != nil {
				return nil, err
			}
		}
		if len(sh.rows) > 0 {
			last, _ := excelize.CoordinatesToCellName(len(sh.rows[0]), 1)
			style, err := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
			if err != nil {
				return nil, err
			}
			if err := f.SetCellStyle(name, "A1", last, style); err != nil {
				return nil, err
			}
			end, _ := excelize.ColumnNumberToName(len(sh.rows[0]))
			if err := f.SetColWidth(name, "A", end, 24); err != nil {
				return nil, err
			}
		}
	}
	if first == "" {
		if err := f.SetSheetName("Sheet1", sheetName(empty, used)); err != nil {
			return nil, err
		}
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sheetName(s string, used map[string]bool) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`[]:*?/\`, r) {
			return '-'
		}
		return r
	}, strings.TrimSpace(s))
	s = strings.Trim(s, "'")
	if s == "" {
		s = "-"
	}
	base := []rune(s)
	if len(base) > 31 {
		base = base[:31]
	}
	name := string(base)
	for i := 2; used[strings.ToLower(name)]; i++ {
		suffix := " (" + strconv.Itoa(i) + ")"
		b := base
		if len(b)+len(suffix) > 31 {
			b = b[:31-len(suffix)]
		}
		name = string(b) + suffix
	}
	used[strings.ToLower(name)] = true
	return name
}

// CommissioningList exports a list of a version as XLSX.
func (s *Service) CommissioningList(ctx context.Context, versionID uuid.UUID, kind string) (Export, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Export{}, err
	}
	if kind != ListHDL && kind != ListZigbee && kind != ListKNX {
		return Export{}, apperr.New(http.StatusNotFound, "export.unknown", "no such export")
	}
	d, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Export{}, err
	}
	data, err := workbook(commissioning(d, kind), d.lang.t("noDevices"))
	if err != nil {
		return Export{}, err
	}
	return Export{FileName: exportName(d, d.lang.t("file-"+kind), "xlsx"),
		ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Data: data}, nil
}
