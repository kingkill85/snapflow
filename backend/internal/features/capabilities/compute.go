package capabilities

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// Capabilities is what SnapFlow knows about a product (or one of its
// variants) for the board checks, computed from its attribute values and the
// meanings of the catalog fields its category's attributes link (D187).
// Empty values do not count: a missing number is absent (nil), never 0.
type Capabilities struct {
	// Mounting is the effective mounting: the product's override, else its
	// category's.
	Mounting string `json:"mounting" enum:"floorplan,board,both"`
	// Channels by output kind, in output kind order.
	Channels      []ChannelCapability `json:"channels"`
	ModuleTotalA  *float64            `json:"moduleTotalA,omitempty" doc:"Limit for the whole module (A)"`
	ModuleTotalsW []Limit             `json:"moduleTotalsW" doc:"Limits for the whole module (W): one without a load type applies to any load"`
	// BusCurrentUsedMa falls back to the product type's default for a bus
	// system (BusCurrentUsedMaDefault says so).
	BusCurrentUsedMa        *float64 `json:"busCurrentUsedMa,omitempty"`
	BusCurrentUsedMaDefault bool     `json:"busCurrentUsedMaDefault" doc:"busCurrentUsedMa is the product type's default (the product has no value)"`
	BusCurrentSuppliedMa    *float64 `json:"busCurrentSuppliedMa,omitempty"`
	BusDevicesMax           *float64 `json:"busDevicesMax,omitempty"`
	RailWidthTE             *float64 `json:"railWidthTe,omitempty" doc:"Width on the DIN rail in TE (17.5 mm), decimal"`
	EnclosureRows           *float64 `json:"enclosureRows,omitempty"`
	EnclosureTEPerRow       *float64 `json:"enclosureTePerRow,omitempty"`
	WirelessPlacesSupplied  *float64 `json:"wirelessPlacesSupplied,omitempty"`
	// WirelessPlacesUsed falls back to the product type's default for a
	// wireless system.
	WirelessPlacesUsed        *float64 `json:"wirelessPlacesUsed,omitempty"`
	WirelessPlacesUsedDefault bool     `json:"wirelessPlacesUsedDefault" doc:"wirelessPlacesUsed is the product type's default (the product has no value)"`
	ZigbeeRouter              *bool    `json:"zigbeeRouter,omitempty"`
	MotorType                 string   `json:"motorType,omitempty" enum:"ac,dc" doc:"Motors the blind outputs drive (D310)"`
	// Missing lists what the checks still need of the product (D447);
	// left out when nothing is missing.
	Missing []Missing `json:"missing,omitempty" doc:"What the checks still need of the product (readiness codes); left out when nothing is missing"`
}

// MissingCode is a product-level readiness code (D446, D447).
type MissingCode string

const (
	// MissingBusCurrent: a device of a bus system without a default bus
	// current has no bus current value.
	MissingBusCurrent MissingCode = "product_bus_current_missing"
	// MissingBoardWidth: mounted on the board, but no rail width.
	MissingBoardWidth MissingCode = "product_board_without_width"
	// MissingChannels: the category has a channels field, the value is
	// empty.
	MissingChannels MissingCode = "product_channels_missing"
	// MissingChannelLimit: channels, but no W or A limit for them.
	MissingChannelLimit MissingCode = "product_channel_without_limit"
)

// MissingCodes are the product-level codes in display order.
var MissingCodes = []MissingCode{MissingBoardWidth, MissingChannels, MissingBusCurrent, MissingChannelLimit}

// Missing is one thing the checks still need of a product.
type Missing struct {
	Code MissingCode `json:"code" enum:"product_board_without_width,product_channels_missing,product_bus_current_missing,product_channel_without_limit"`
}

// HasMissing reports whether c lists the code.
func (c Capabilities) HasMissing(code MissingCode) bool {
	return slices.ContainsFunc(c.Missing, func(m Missing) bool { return m.Code == code })
}

// MergeMissing is the missing list of a product with variants: a code
// counts when any active variant lacks it (variants carry
// the product's values too). Without variants the product's own list.
func MergeMissing(product Capabilities, variants []Capabilities) []Missing {
	if len(variants) == 0 {
		return product.Missing
	}
	var out []Missing
	for _, code := range MissingCodes {
		if slices.ContainsFunc(variants, func(v Capabilities) bool { return v.HasMissing(code) }) {
			out = append(out, Missing{Code: code})
		}
	}
	return out
}

// ChannelCapability is the channels of one output kind a product supplies.
type ChannelCapability struct {
	OutputKindID  uuid.UUID `json:"outputKindId"`
	OutputKindKey string    `json:"outputKindKey"`
	Count         int       `json:"count"`
	LimitsW       []Limit   `json:"limitsW" doc:"Max W per channel by load type"`
	LimitsA       []Limit   `json:"limitsA" doc:"Max A per channel; one without a load type applies to any load"`
	MinLoadsW     []Limit   `json:"minLoadsW" doc:"Minimum load per channel (W); one without a load type applies to any load"`
	VoltageV      *float64  `json:"voltageV,omitempty" doc:"Voltage the channels switch (channel_voltage); absent = the product type's nominal voltage"`
	// Alternatives: the kinds these channels can act as, Per channels as
	// one (fixed groups 1..Per, Per+1..2*Per, ...), at most Max of them;
	// only kinds the product opts in to (alternative_allowed, D303). The
	// channels are counted once: using a group as the alternative takes
	// those channels away from Count (no double counting).
	Alternatives []ChannelAlternative `json:"alternatives" doc:"Other kinds these channels can act as (the product opts in), in fixed groups of per channels"`
}

// Limit is a value for one load type, or for any load (no load type).
type Limit struct {
	LoadTypeID  *uuid.UUID `json:"loadTypeId,omitempty" doc:"Empty = any load type"`
	LoadTypeKey string     `json:"loadTypeKey,omitempty"`
	Value       float64    `json:"value"`
}

// ChannelAlternative: Per channels act as one channel of OutputKindID.
type ChannelAlternative struct {
	OutputKindID  uuid.UUID `json:"outputKindId"`
	OutputKindKey string    `json:"outputKindKey"`
	Per           int       `json:"per" doc:"Channels used for one (a fixed group: 1..per, per+1..2*per, ...)"`
	Max           int       `json:"max" doc:"How many of that kind these channels give at most: floor(count / per)"`
}

// Registry is the configuration Compute needs: the catalog fields with
// meanings, the active output kinds and the load types. Read it once per
// request (Service.Registry) and compute any number of products with it.
type Registry struct {
	Fields      map[string]CatalogField
	OutputKinds []OutputKind
	LoadTypes   map[uuid.UUID]LoadType
}

// Registry reads the configuration for Compute in one snapshot. Inactive
// output kinds are left out: their channels and alternatives are not
// reported (D311).
func (s *Service) Registry(ctx context.Context) (Registry, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return Registry{}, err
	}
	reg := Registry{Fields: map[string]CatalogField{}, LoadTypes: map[uuid.UUID]LoadType{}}
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		fields, err := readFields(ctx, q, actor)
		if err != nil {
			return err
		}
		for _, f := range fields {
			reg.Fields[f.Key] = f
		}
		if reg.OutputKinds, err = readOutputKinds(ctx, q, actor, false); err != nil {
			return err
		}
		loads, err := q.ListLoadTypes(ctx, true)
		if err != nil {
			return err
		}
		for _, l := range loads {
			reg.LoadTypes[l.ID] = loadTypeOut(actor, l)
		}
		return nil
	})
	return reg, err
}

// Topology is how devices of a product type connect (D304).
type Topology string

const (
	TopologyBus      Topology = "bus"
	TopologyWireless Topology = "wireless"
	TopologyNone     Topology = "none"
)

// ProductTypeDefaults are the product type settings Compute falls back to.
type ProductTypeDefaults struct {
	Topology                  Topology
	DefaultBusCurrentMa       *int32
	DefaultWirelessPlacesUsed *int32
}

// Input is one product or variant to compute.
type Input struct {
	ProductTypeID uuid.UUID
	// ProductType gives the defaults by topology (bus current, wireless
	// places used) for values the product lacks.
	ProductType ProductTypeDefaults
	// Mounting is the effective mounting (product override or category).
	Mounting string
	// Schema is the category's attribute schema; only attributes linked to a
	// catalog field (fieldKey) with a meaning count.
	Schema attrschema.Schema
	// Values are the product's values, plus a variant's own for a variant.
	Values attrschema.Values
}

// Compute derives the capabilities of a product or variant. Rules: an
// attribute counts when it links a catalog field with a meaning, the meaning
// is not limited to other product types, and the value is set (blank text
// and null do not count); of several attributes with the same meaning and
// parameters the first in schema order wins. Channel limits only appear for
// kinds the product supplies channels of; alternatives only for kinds the
// product opts in to. Bus current used / wireless places used fall back to
// the product type's default by topology.
func Compute(reg Registry, in Input) Capabilities {
	out := Capabilities{Mounting: in.Mounting, Channels: []ChannelCapability{}, ModuleTotalsW: []Limit{}}
	type channelData struct {
		count                 *float64
		limitW, limitA, minW  limits
		voltage               *float64
		alternativeAllowed    bool
		alternativeAllowedSet bool
	}
	channels := map[uuid.UUID]*channelData{}
	// Kinds whose channels_supplied field the category has; true once the
	// product gives a value (0 counts as given).
	channelFields := map[uuid.UUID]bool{}
	ch := func(id uuid.UUID) *channelData {
		c := channels[id]
		if c == nil {
			c = &channelData{}
			channels[id] = c
		}
		return c
	}
	var moduleW limits
	setOnce := func(dst **float64, v float64) {
		if *dst == nil {
			*dst = &v
		}
	}
	for _, a := range in.Schema {
		if a.FieldKey == "" {
			continue
		}
		f, ok := reg.Fields[a.FieldKey]
		if !ok || f.Meaning == MeaningNone {
			continue
		}
		if len(f.ProductTypeIDs) > 0 && !slices.Contains(f.ProductTypeIDs, in.ProductTypeID) {
			continue
		}
		if f.Meaning == MeaningChannelsSupplied {
			if _, seen := channelFields[deref0(f.OutputKindID)]; !seen {
				channelFields[deref0(f.OutputKindID)] = false
			}
		}
		raw, ok := in.Values[a.Key]
		if !ok || raw == nil {
			continue
		}
		switch f.Meaning {
		case MeaningZigbeeRouter:
			if b, ok := raw.(bool); ok && out.ZigbeeRouter == nil {
				out.ZigbeeRouter = &b
			}
			continue
		case MeaningAlternativeAllowed:
			if b, ok := raw.(bool); ok {
				c := ch(deref0(f.OutputKindID))
				if !c.alternativeAllowedSet {
					c.alternativeAllowed, c.alternativeAllowedSet = b, true
				}
			}
			continue
		case MeaningMotorType:
			if s, ok := raw.(string); ok && out.MotorType == "" {
				switch m := strings.ToLower(strings.TrimSpace(s)); m {
				case "ac", "dc":
					out.MotorType = m
				}
			}
			continue
		case MeaningWirelessPlaceUsed:
			// Yes/no: no = 0 places, yes = 1 (D312); a number as is.
			if b, ok := raw.(bool); ok {
				n := 0.0
				if b {
					n = 1
				}
				setOnce(&out.WirelessPlacesUsed, n)
				continue
			}
		}
		n, ok := number(raw)
		if !ok {
			continue
		}
		switch f.Meaning {
		case MeaningChannelsSupplied:
			channelFields[deref0(f.OutputKindID)] = true
			setOnce(&ch(deref0(f.OutputKindID)).count, n)
		case MeaningChannelLimitW:
			ch(deref0(f.OutputKindID)).limitW.add(f.LoadTypeID, n)
		case MeaningChannelLimitA:
			ch(deref0(f.OutputKindID)).limitA.add(f.LoadTypeID, n)
		case MeaningChannelMinLoadW:
			ch(deref0(f.OutputKindID)).minW.add(f.LoadTypeID, n)
		case MeaningChannelVoltage:
			if n > 0 {
				setOnce(&ch(deref0(f.OutputKindID)).voltage, n)
			}
		case MeaningModuleTotalA:
			setOnce(&out.ModuleTotalA, n)
		case MeaningModuleTotalW:
			moduleW.add(f.LoadTypeID, n)
		case MeaningBusCurrentUsedMa:
			setOnce(&out.BusCurrentUsedMa, n)
		case MeaningBusCurrentSuppliedMa:
			setOnce(&out.BusCurrentSuppliedMa, n)
		case MeaningBusDevicesMax:
			setOnce(&out.BusDevicesMax, n)
		case MeaningRailWidthTE:
			setOnce(&out.RailWidthTE, n)
		case MeaningEnclosureRows:
			setOnce(&out.EnclosureRows, n)
		case MeaningEnclosureTEPerRow:
			setOnce(&out.EnclosureTEPerRow, n)
		case MeaningWirelessPlacesSupplied:
			setOnce(&out.WirelessPlacesSupplied, n)
		case MeaningWirelessPlaceUsed:
			setOnce(&out.WirelessPlacesUsed, n)
		}
	}
	out.ModuleTotalsW = moduleW.list(reg)
	// Defaults by topology (D304).
	pt := in.ProductType
	if pt.Topology == TopologyBus && out.BusCurrentUsedMa == nil && pt.DefaultBusCurrentMa != nil {
		v := float64(*pt.DefaultBusCurrentMa)
		out.BusCurrentUsedMa, out.BusCurrentUsedMaDefault = &v, true
	}
	if pt.Topology == TopologyWireless && out.WirelessPlacesUsed == nil && pt.DefaultWirelessPlacesUsed != nil {
		v := float64(*pt.DefaultWirelessPlacesUsed)
		out.WirelessPlacesUsed, out.WirelessPlacesUsedDefault = &v, true
	}
	// Channels in output kind order (active kinds only); alternatives from
	// the active kinds that list this kind, where the product opts in.
	for _, k := range reg.OutputKinds {
		c := channels[k.ID]
		if c == nil || c.count == nil || *c.count < 1 {
			continue
		}
		count := int(math.Floor(*c.count))
		cc := ChannelCapability{OutputKindID: k.ID, OutputKindKey: k.Key, Count: count,
			LimitsW: c.limitW.list(reg), LimitsA: c.limitA.list(reg), MinLoadsW: c.minW.list(reg), VoltageV: c.voltage,
			Alternatives: []ChannelAlternative{}}
		for _, target := range reg.OutputKinds {
			t := channels[target.ID]
			if t == nil || !t.alternativeAllowed {
				continue
			}
			for _, alt := range target.Alternatives {
				if alt.OutputKindID == k.ID && alt.Count > 0 && count/int(alt.Count) > 0 {
					cc.Alternatives = append(cc.Alternatives, ChannelAlternative{OutputKindID: target.ID, OutputKindKey: target.Key,
						Per: int(alt.Count), Max: count / int(alt.Count)})
				}
			}
		}
		out.Channels = append(out.Channels, cc)
	}
	out.Missing = missing(reg, in, out, channelFields)
	return out
}

// missing derives the product-level readiness codes (D446) in
// MissingCodes order; nil when nothing is missing. Enclosures and bus power
// supplies are not bus devices and need no width or bus current of their
// own.
func missing(reg Registry, in Input, c Capabilities, channelFields map[uuid.UUID]bool) []Missing {
	enclosure := c.EnclosureRows != nil
	var out []Missing
	add := func(code MissingCode) { out = append(out, Missing{Code: code}) }
	if (c.Mounting == string(MountingBoard) || c.Mounting == string(MountingBoth)) && c.RailWidthTE == nil && !enclosure {
		add(MissingBoardWidth)
	}
	// Channels: the category has channels fields of active kinds and the
	// product gives none of them a value (a device has channels of one or
	// two kinds, not of every kind its category lists). Power supplies,
	// gateways and enclosures have no channels.
	infrastructure := c.BusCurrentSuppliedMa != nil || c.WirelessPlacesSupplied != nil || enclosure
	hasField, given := false, false
	for _, k := range reg.OutputKinds {
		if v, ok := channelFields[k.ID]; ok {
			hasField, given = true, given || v
		}
	}
	if hasField && !given && !infrastructure {
		add(MissingChannels)
	}
	if in.ProductType.Topology == TopologyBus && c.BusCurrentUsedMa == nil && c.BusCurrentSuppliedMa == nil && !enclosure {
		add(MissingBusCurrent)
	}
	// Limits: only for kinds the catalog has a W or A limit field for
	// (inputs have none).
	limitFields := map[uuid.UUID]bool{}
	for _, f := range reg.Fields {
		if (f.Meaning == MeaningChannelLimitW || f.Meaning == MeaningChannelLimitA) && f.OutputKindID != nil {
			limitFields[*f.OutputKindID] = true
		}
	}
	for _, cc := range c.Channels {
		if limitFields[cc.OutputKindID] && len(cc.LimitsW) == 0 && len(cc.LimitsA) == 0 {
			add(MissingChannelLimit)
			break
		}
	}
	return out
}

// limits collects values by load type (uuid.Nil = any load); the first per
// load type wins.
type limits struct {
	values map[uuid.UUID]float64
	order  []uuid.UUID
}

func (l *limits) add(loadType *uuid.UUID, v float64) {
	id := deref0(loadType)
	if l.values == nil {
		l.values = map[uuid.UUID]float64{}
	}
	if _, set := l.values[id]; set {
		return
	}
	l.values[id] = v
	l.order = append(l.order, id)
}

// list returns the limits, the one for any load first, then by load type
// order.
func (l *limits) list(reg Registry) []Limit {
	out := []Limit{}
	for _, id := range l.order {
		lim := Limit{Value: l.values[id]}
		if id != uuid.Nil {
			id := id
			lim.LoadTypeID, lim.LoadTypeKey = &id, reg.LoadTypes[id].Key
		}
		out = append(out, lim)
	}
	order := func(x Limit) int {
		if x.LoadTypeID == nil {
			return -1
		}
		return int(reg.LoadTypes[*x.LoadTypeID].SortOrder)
	}
	slices.SortStableFunc(out, func(a, b Limit) int { return order(a) - order(b) })
	return out
}

// number reads a numeric value (jsonb numbers decode as float64; saved
// values may be int64).
func number(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

func deref0(id *uuid.UUID) uuid.UUID {
	if id == nil {
		return uuid.Nil
	}
	return *id
}
