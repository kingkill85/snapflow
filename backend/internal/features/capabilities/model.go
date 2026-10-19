package capabilities

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// LoadType is a kind of load a need has (LED, halogen, AC motor, ...).
type LoadType struct {
	ID        uuid.UUID    `json:"id"`
	Key       string       `json:"key" example:"led"`
	Name      i18n.Text    `json:"name"`
	SortOrder int32        `json:"sortOrder"`
	IsActive  bool         `json:"isActive"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can       auth.Actions `json:"can"`
}

type LoadTypeInput struct {
	Key      string    `json:"key" doc:"Lower snake case, 1-64 characters" example:"led"`
	Name     i18n.Text `json:"name" doc:"At most 100 characters; \"en\" is required"`
	IsActive bool      `json:"isActive"`
}

type LoadTypeUpdate struct {
	LoadTypeInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if it changed since, the update fails with load_type.stale"`
}

// OutputKind is a kind of channel a module supplies (dimmer output, relay
// output, ...).
type OutputKind struct {
	ID              uuid.UUID   `json:"id"`
	Key             string      `json:"key" example:"blind_output"`
	Name            i18n.Text   `json:"name"`
	SortOrder       int32       `json:"sortOrder"`
	IsActive        bool        `json:"isActive"`
	FunctionTypeIDs []uuid.UUID `json:"functionTypeIds" doc:"The function types a channel of this kind serves"`
	// Alternative: AlternativeCount channels of AlternativeKindID act as one
	// channel of this kind (2 relay outputs = 1 blind output).
	Alternative *OutputKindAlternative `json:"alternative,omitempty" doc:"N channels of another kind act as one of this kind (e.g. 2 relay outputs = 1 blind output)"`
	CreatedAt   time.Time              `json:"createdAt"`
	UpdatedAt   time.Time              `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can         auth.Actions           `json:"can"`
}

// OutputKindAlternative says Count channels of OutputKindID act as one
// channel of the kind that has it.
type OutputKindAlternative struct {
	OutputKindID uuid.UUID `json:"outputKindId"`
	Count        int32     `json:"count" minimum:"1" maximum:"16" doc:"How many channels of that kind make one of this kind"`
}

type OutputKindInput struct {
	Key             string                 `json:"key" doc:"Lower snake case, 1-64 characters" example:"blind_output"`
	Name            i18n.Text              `json:"name" doc:"At most 100 characters; \"en\" is required"`
	IsActive        bool                   `json:"isActive"`
	FunctionTypeIDs []uuid.UUID            `json:"functionTypeIds,omitempty" maxItems:"200" doc:"Function types it serves (existing ones, each once)"`
	Alternative     *OutputKindAlternative `json:"alternative,omitempty" doc:"Leave out for none"`
}

type OutputKindUpdate struct {
	OutputKindInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if it changed since, the update fails with output_kind.stale"`
}

// Meaning is what a catalog field's value means for the checks (D187).
type Meaning string

const (
	MeaningNone                   Meaning = ""
	MeaningChannelsSupplied       Meaning = "channels_supplied"
	MeaningChannelLimitW          Meaning = "channel_limit_w"
	MeaningChannelLimitA          Meaning = "channel_limit_a"
	MeaningChannelMinLoadW        Meaning = "channel_min_load_w"
	MeaningModuleTotalA           Meaning = "module_total_a"
	MeaningModuleTotalW           Meaning = "module_total_w"
	MeaningBusCurrentUsedMa       Meaning = "bus_current_used_ma"
	MeaningBusCurrentSuppliedMa   Meaning = "bus_current_supplied_ma"
	MeaningBusDevicesMax          Meaning = "bus_devices_max"
	MeaningRailWidthTE            Meaning = "rail_width_te"
	MeaningEnclosureRows          Meaning = "enclosure_rows"
	MeaningEnclosureTEPerRow      Meaning = "enclosure_te_per_row"
	MeaningWirelessPlacesSupplied Meaning = "wireless_places_supplied"
	MeaningWirelessPlaceUsed      Meaning = "wireless_place_used"
	MeaningZigbeeRouter           Meaning = "zigbee_router"
	MeaningMotorType              Meaning = "motor_type"
)

// MeaningSpec describes a meaning: its parameters and the value types it
// accepts.
type MeaningSpec struct {
	Meaning    Meaning           `json:"meaning"`
	OutputKind bool              `json:"outputKind" doc:"Needs an output kind (outputKindId)"`
	LoadType   bool              `json:"loadType" doc:"Needs a load type (loadTypeId)"`
	Types      []attrschema.Type `json:"types" doc:"Value types a field with this meaning may have"`
}

var numeric = []attrschema.Type{attrschema.TypeNumber, attrschema.TypeInteger}

// Meanings lists every meaning with its parameters and accepted types, in
// display order.
var Meanings = []MeaningSpec{
	{Meaning: MeaningChannelsSupplied, OutputKind: true, Types: numeric},
	{Meaning: MeaningChannelLimitW, OutputKind: true, LoadType: true, Types: numeric},
	{Meaning: MeaningChannelLimitA, OutputKind: true, Types: numeric},
	{Meaning: MeaningChannelMinLoadW, OutputKind: true, Types: numeric},
	{Meaning: MeaningModuleTotalA, Types: numeric},
	{Meaning: MeaningModuleTotalW, Types: numeric},
	{Meaning: MeaningBusCurrentUsedMa, Types: numeric},
	{Meaning: MeaningBusCurrentSuppliedMa, Types: numeric},
	{Meaning: MeaningBusDevicesMax, Types: numeric},
	{Meaning: MeaningRailWidthTE, Types: numeric},
	{Meaning: MeaningEnclosureRows, Types: numeric},
	{Meaning: MeaningEnclosureTEPerRow, Types: numeric},
	{Meaning: MeaningWirelessPlacesSupplied, Types: numeric},
	{Meaning: MeaningWirelessPlaceUsed, Types: []attrschema.Type{attrschema.TypeNumber, attrschema.TypeInteger, attrschema.TypeBoolean}},
	{Meaning: MeaningZigbeeRouter, Types: []attrschema.Type{attrschema.TypeBoolean}},
	{Meaning: MeaningMotorType, Types: []attrschema.Type{attrschema.TypeEnum, attrschema.TypeText}},
}

func meaningSpec(m Meaning) (MeaningSpec, bool) {
	for _, s := range Meanings {
		if s.Meaning == m {
			return s, true
		}
	}
	return MeaningSpec{}, false
}

// CatalogField is a known column or field of the whole catalog (D188): its
// value type and unit, and what its value means for the checks.
type CatalogField struct {
	ID          uuid.UUID                    `json:"id"`
	Key         string                       `json:"key" example:"dimmer_outputs"`
	Label       i18n.Text                    `json:"label"`
	Type        attrschema.Type              `json:"type" enum:"text,number,integer,boolean,enum"`
	Unit        string                       `json:"unit,omitempty" example:"W"`
	Options     []attrschema.AttributeOption `json:"options" doc:"Allowed values of an enum field"`
	EtimFeature string                       `json:"etimFeature,omitempty" doc:"ETIM feature code, informational" example:"EF000008"`
	// Meaning empty = just information.
	Meaning        Meaning      `json:"meaning,omitempty" enum:"channels_supplied,channel_limit_w,channel_limit_a,channel_min_load_w,module_total_a,module_total_w,bus_current_used_ma,bus_current_supplied_ma,bus_devices_max,rail_width_te,enclosure_rows,enclosure_te_per_row,wireless_places_supplied,wireless_place_used,zigbee_router,motor_type" doc:"What the value means for the checks; empty = just information"`
	OutputKindID   *uuid.UUID   `json:"outputKindId,omitempty" doc:"Parameter of the channel meanings"`
	LoadTypeID     *uuid.UUID   `json:"loadTypeId,omitempty" doc:"Parameter of channel_limit_w"`
	ProductTypeIDs []uuid.UUID  `json:"productTypeIds" doc:"The meaning applies only to products of these product types; empty = all"`
	SortOrder      int32        `json:"sortOrder"`
	CreatedAt      time.Time    `json:"createdAt"`
	UpdatedAt      time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can            auth.Actions `json:"can"`
}

type CatalogFieldInput struct {
	Key            string                       `json:"key" doc:"Lower snake case, 1-64 characters" example:"dimmer_outputs"`
	Label          i18n.Text                    `json:"label" doc:"At most 100 characters; \"en\" is required"`
	Type           attrschema.Type              `json:"type" enum:"text,number,integer,boolean,enum"`
	Unit           string                       `json:"unit,omitempty" doc:"Display only, at most 16 characters"`
	Options        []attrschema.AttributeOption `json:"options,omitempty" doc:"Enum fields: the allowed values (at least one)"`
	EtimFeature    string                       `json:"etimFeature,omitempty" maxLength:"20" doc:"ETIM feature code, e.g. EF000008"`
	Meaning        Meaning                      `json:"meaning,omitempty" enum:"channels_supplied,channel_limit_w,channel_limit_a,channel_min_load_w,module_total_a,module_total_w,bus_current_used_ma,bus_current_supplied_ma,bus_devices_max,rail_width_te,enclosure_rows,enclosure_te_per_row,wireless_places_supplied,wireless_place_used,zigbee_router,motor_type" doc:"Leave out for just information"`
	OutputKindID   *uuid.UUID                   `json:"outputKindId,omitempty" doc:"Required by the channel meanings, else not allowed"`
	LoadTypeID     *uuid.UUID                   `json:"loadTypeId,omitempty" doc:"Required by channel_limit_w, else not allowed"`
	ProductTypeIDs []uuid.UUID                  `json:"productTypeIds,omitempty" maxItems:"200" doc:"Limit the meaning to these product types; empty = all"`
}

type CatalogFieldUpdate struct {
	CatalogFieldInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if it changed since, the update fails with catalog_field.stale"`
}

// Definition returns the attribute definition a category attribute linked
// to the field gets (key and scope are the category's).
func (f CatalogField) Definition(key string) attrschema.Definition {
	d := attrschema.Definition{Key: key, Label: f.Label, Type: f.Type, Unit: f.Unit, FieldKey: f.Key}
	if f.Type == attrschema.TypeEnum {
		d.Options = f.Options
	}
	return d
}

// Mounting is where products are placed (D189).
type Mounting string

const (
	MountingFloorplan Mounting = "floorplan"
	MountingBoard     Mounting = "board"
	MountingBoth      Mounting = "both"
)

// ValidMounting reports whether m is a mounting value.
func ValidMounting(m string) bool {
	switch Mounting(m) {
	case MountingFloorplan, MountingBoard, MountingBoth:
		return true
	}
	return false
}
