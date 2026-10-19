package installation

import (
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
)

// How the documents name things (one place for the manual, labels and
// lists).

func (d *data) item(planID, itemID uuid.UUID) *itemRef {
	if it, ok := d.itemByKey[[2]uuid.UUID{planID, itemID}]; ok {
		return it
	}
	return &itemRef{planID: planID, itemID: itemID}
}

func (d *data) productName(vid *uuid.UUID) string {
	if vid == nil {
		return ""
	}
	v, ok := d.variants[*vid]
	if !ok {
		return ""
	}
	name := text(v.ProductName, d.lang)
	if vn := text(v.VariantName, d.lang); vn != "" && vn != name {
		name += " – " + vn
	}
	return name
}

func (d *data) model(vid *uuid.UUID) string {
	if vid == nil {
		return ""
	}
	return d.variants[*vid].ModelNumber
}

// itemName: a module is "<board> D<n>", a device its label, else its
// product.
func (d *data) itemName(it *itemRef) string {
	if it.board {
		s := it.planName + " " + it.position
		if it.label != "" {
			s += " " + it.label
		}
		return s
	}
	if it.label != "" {
		return it.label
	}
	if n := d.productName(it.variantID); n != "" {
		return n
	}
	return d.lang.t("device")
}

// kindName is an output kind's name.
func (d *data) kindName(id uuid.UUID) string {
	if k, ok := d.kinds[id]; ok {
		return text(k.Name, d.lang)
	}
	return ""
}

// channelText: "<kind> <no>".
func (d *data) channelText(kindID uuid.UUID, no int32) string {
	return strings.TrimSpace(d.kindName(kindID) + " " + strconv.Itoa(int(no)))
}

func (d *data) functionName(id uuid.UUID) string {
	if f, ok := d.functions[id]; ok {
		return text(f.Name, d.lang)
	}
	return ""
}

// needName is a need's label, else its function.
func (d *data) needName(n *wiring.NeedInfo) string {
	if n.Label != "" {
		return n.Label
	}
	return d.functionName(n.FunctionTypeID)
}

// needWithFunction: "<label> (<function>)", or the function alone.
func (d *data) needWithFunction(n *wiring.NeedInfo) string {
	if n.Label == "" {
		return d.functionName(n.FunctionTypeID)
	}
	return n.Label + " (" + d.functionName(n.FunctionTypeID) + ")"
}

// loadText: "3 × 60 W LED" (power and load type when known).
func (d *data) loadText(n *wiring.NeedInfo, units int32) string {
	s := strconv.Itoa(int(units))
	if n.PowerW != nil {
		s += " × " + d.lang.watts(*n.PowerW)
	} else {
		s += " ×"
	}
	if n.LoadTypeID != nil {
		if lt, ok := d.loadTypes[*n.LoadTypeID]; ok {
			s += " " + text(lt.Name, d.lang)
		}
	}
	return s
}

// connectionsOf lists where a need is connected: "Main board D1 · Dimmer 3
// (2 ×)".
func (d *data) connectionsOf(planID, needID uuid.UUID) []string {
	var out []string
	for _, c := range d.wiring.Connections {
		if c.NeedPlanID != planID || c.NeedID != needID {
			continue
		}
		s := d.itemName(d.item(c.TargetPlanID, c.TargetItemID)) + " · " + d.channelText(c.OutputKindID, c.ChannelNo)
		if n := d.needByKey[[2]uuid.UUID{planID, needID}]; n != nil && c.Units != n.Quantity {
			s += " (" + strconv.Itoa(int(c.Units)) + " ×)"
		}
		out = append(out, s)
	}
	return out
}

// addressText is an item's address in its scheme, empty without.
func addressText(a networks.AddressedItem) string {
	if a.Address == nil {
		return ""
	}
	switch a.Scheme {
	case networks.SchemeKNX:
		return a.Address.KNX
	case networks.SchemeHDL:
		return a.Address.HDL
	case networks.SchemeIEEE:
		return a.Address.IEEE
	}
	return ""
}

// networkText is a bus item's line or a wireless device's gateway.
func (d *data) networkText(a networks.AddressedItem) string {
	switch {
	case a.BusLineID != nil:
		return d.lineByID[*a.BusLineID].Name
	case a.GatewayItemID != nil:
		return d.itemName(d.item(*a.GatewayPlanID, *a.GatewayItemID))
	}
	return ""
}

// zoneName of a floorplan zone.
func (d *data) zoneName(planID uuid.UUID, zoneID *uuid.UUID) string {
	if zoneID == nil {
		return d.lang.t("noZone")
	}
	for _, z := range d.checks.Zones {
		if z.PlanID == planID && z.ZoneID != nil && *z.ZoneID == *zoneID {
			return z.Name
		}
	}
	return ""
}
