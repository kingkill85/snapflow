package capabilities

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
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
	Channels               []ChannelCapability `json:"channels"`
	ModuleTotalA           *float64            `json:"moduleTotalA,omitempty" doc:"Limit for the whole module (A)"`
	ModuleTotalW           *float64            `json:"moduleTotalW,omitempty" doc:"Limit for the whole module (W)"`
	BusCurrentUsedMa       *float64            `json:"busCurrentUsedMa,omitempty"`
	BusCurrentSuppliedMa   *float64            `json:"busCurrentSuppliedMa,omitempty"`
	BusDevicesMax          *float64            `json:"busDevicesMax,omitempty"`
	RailWidthTE            *float64            `json:"railWidthTe,omitempty" doc:"Width on the DIN rail in TE (17.5 mm), decimal"`
	EnclosureRows          *float64            `json:"enclosureRows,omitempty"`
	EnclosureTEPerRow      *float64            `json:"enclosureTePerRow,omitempty"`
	WirelessPlacesSupplied *float64            `json:"wirelessPlacesSupplied,omitempty"`
	WirelessPlacesUsed     *float64            `json:"wirelessPlacesUsed,omitempty"`
	ZigbeeRouter           *bool               `json:"zigbeeRouter,omitempty"`
	MotorType              string              `json:"motorType,omitempty" enum:"ac,dc" doc:"Motor type of blind outputs"`
}

// ChannelCapability is the channels of one output kind a product supplies.
type ChannelCapability struct {
	OutputKindID  uuid.UUID   `json:"outputKindId"`
	OutputKindKey string      `json:"outputKindKey"`
	Count         int         `json:"count"`
	LimitA        *float64    `json:"limitA,omitempty" doc:"Max A per channel"`
	MinLoadW      *float64    `json:"minLoadW,omitempty" doc:"Minimum load per channel (W)"`
	LimitsW       []LoadLimit `json:"limitsW" doc:"Max W per channel by load type"`
	// Alternatives: kinds whose alternative is this kind, i.e. Per channels
	// of this kind act as one channel of OutputKindID (2 relay outputs = 1
	// blind output), at most Max of them.
	Alternatives []ChannelAlternative `json:"alternatives" doc:"Other kinds these channels can act as, per group of channels"`
}

// LoadLimit is a channel's limit for one load type.
type LoadLimit struct {
	LoadTypeID  uuid.UUID `json:"loadTypeId"`
	LoadTypeKey string    `json:"loadTypeKey"`
	MaxW        float64   `json:"maxW"`
}

// ChannelAlternative: Per channels act as one channel of OutputKindID.
type ChannelAlternative struct {
	OutputKindID  uuid.UUID `json:"outputKindId"`
	OutputKindKey string    `json:"outputKindKey"`
	Per           int       `json:"per" doc:"Channels used for one"`
	Max           int       `json:"max" doc:"How many of that kind these channels give at most"`
}

// Registry is the configuration Compute needs: the catalog fields with
// meanings, the output kinds and the load types. Read it once per request
// (Service.Registry) and compute any number of products with it.
type Registry struct {
	Fields      map[string]CatalogField
	OutputKinds []OutputKind
	LoadTypes   map[uuid.UUID]LoadType
}

// Registry reads the configuration for Compute.
func (s *Service) Registry(ctx context.Context) (Registry, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return Registry{}, err
	}
	fields, err := s.FieldsByKey(ctx)
	if err != nil {
		return Registry{}, err
	}
	kinds, err := s.OutputKinds(ctx, true)
	if err != nil {
		return Registry{}, err
	}
	loads, err := s.LoadTypes(ctx, true)
	if err != nil {
		return Registry{}, err
	}
	reg := Registry{Fields: fields, OutputKinds: kinds, LoadTypes: make(map[uuid.UUID]LoadType, len(loads))}
	for _, l := range loads {
		reg.LoadTypes[l.ID] = l
	}
	return reg, nil
}

// Input is one product or variant to compute.
type Input struct {
	ProductTypeID uuid.UUID
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
// is not limited to other product types, and the value is set (blank text,
// null and false-for-numbers do not count); of several attributes with the
// same meaning and parameters the first in schema order wins. Channel limits
// only appear for kinds the product supplies channels of.
func Compute(reg Registry, in Input) Capabilities {
	out := Capabilities{Mounting: in.Mounting, Channels: []ChannelCapability{}}
	type channelData struct {
		count          *float64
		limitA, minW   *float64
		limitW         map[uuid.UUID]float64
		limitLoadOrder []uuid.UUID
	}
	channels := map[uuid.UUID]*channelData{}
	ch := func(id uuid.UUID) *channelData {
		c := channels[id]
		if c == nil {
			c = &channelData{limitW: map[uuid.UUID]float64{}}
			channels[id] = c
		}
		return c
	}
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
		case MeaningMotorType:
			if s, ok := raw.(string); ok && out.MotorType == "" {
				switch m := strings.ToLower(strings.TrimSpace(s)); m {
				case "ac", "dc":
					out.MotorType = m
				}
			}
			continue
		}
		n, ok := number(raw)
		if !ok {
			continue
		}
		switch f.Meaning {
		case MeaningChannelsSupplied:
			setOnce(&ch(deref0(f.OutputKindID)).count, n)
		case MeaningChannelLimitW:
			c := ch(deref0(f.OutputKindID))
			lt := deref0(f.LoadTypeID)
			if _, set := c.limitW[lt]; !set {
				c.limitW[lt] = n
				c.limitLoadOrder = append(c.limitLoadOrder, lt)
			}
		case MeaningChannelLimitA:
			setOnce(&ch(deref0(f.OutputKindID)).limitA, n)
		case MeaningChannelMinLoadW:
			setOnce(&ch(deref0(f.OutputKindID)).minW, n)
		case MeaningModuleTotalA:
			setOnce(&out.ModuleTotalA, n)
		case MeaningModuleTotalW:
			setOnce(&out.ModuleTotalW, n)
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
	// Channels in output kind order; alternatives from the kinds that name
	// this kind as theirs.
	for _, k := range reg.OutputKinds {
		c := channels[k.ID]
		if c == nil || c.count == nil || *c.count < 1 {
			continue
		}
		count := int(math.Floor(*c.count))
		cc := ChannelCapability{OutputKindID: k.ID, OutputKindKey: k.Key, Count: count, LimitA: c.limitA, MinLoadW: c.minW,
			LimitsW: []LoadLimit{}, Alternatives: []ChannelAlternative{}}
		for _, lt := range c.limitLoadOrder {
			cc.LimitsW = append(cc.LimitsW, LoadLimit{LoadTypeID: lt, LoadTypeKey: reg.LoadTypes[lt].Key, MaxW: c.limitW[lt]})
		}
		slices.SortStableFunc(cc.LimitsW, func(a, b LoadLimit) int {
			return int(reg.LoadTypes[a.LoadTypeID].SortOrder) - int(reg.LoadTypes[b.LoadTypeID].SortOrder)
		})
		for _, other := range reg.OutputKinds {
			if alt := other.Alternative; alt != nil && alt.OutputKindID == k.ID && alt.Count > 0 && count/int(alt.Count) > 0 {
				cc.Alternatives = append(cc.Alternatives, ChannelAlternative{OutputKindID: other.ID, OutputKindKey: other.Key,
					Per: int(alt.Count), Max: count / int(alt.Count)})
			}
		}
		out.Channels = append(out.Channels, cc)
	}
	return out
}

// number reads a numeric value (jsonb numbers decode as float64; saved
// values may be int64). true counts as 1 (wireless_place_used as yes/no),
// false as nothing.
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
	case bool:
		return 1, x
	}
	return 0, false
}

func deref0(id *uuid.UUID) uuid.UUID {
	if id == nil {
		return uuid.Nil
	}
	return *id
}
