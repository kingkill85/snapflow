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
	ID   uuid.UUID `json:"id"`
	Key  string    `json:"key" example:"led"`
	Name i18n.Text `json:"name"`
	// PowerFactor converts W into A: I = P / (V · PF) (D407).
	PowerFactor float64      `json:"powerFactor" doc:"0.10-1.00; converts W into A for limits in A: I = P / (V · PF)"`
	SortOrder   int32        `json:"sortOrder"`
	IsActive    bool         `json:"isActive"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can         auth.Actions `json:"can"`
}

type LoadTypeInput struct {
	Key         string    `json:"key" doc:"Lower snake case, 1-64 characters" example:"led"`
	Name        i18n.Text `json:"name" doc:"At most 100 characters; \"en\" is required"`
	IsActive    bool      `json:"isActive"`
	PowerFactor *float64  `json:"powerFactor,omitempty" doc:"0.10-1.00, two decimals; default 1.00; on update, left out keeps the stored value"`
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
	// Alternatives: Count channels of OutputKindID act as one channel of
	// this kind (2 relay outputs = 1 blind output), as fixed groups (1+2,
	// 3+4, ...); a product uses them only where it opts in (meaning
	// alternative_allowed, D303).
	Alternatives []OutputKindAlternative `json:"alternatives" doc:"Channels of other kinds that can act as one of this kind (e.g. 2 relay outputs = 1 blind output), in fixed groups; products opt in with a field of meaning alternative_allowed"`
	CreatedAt    time.Time               `json:"createdAt"`
	UpdatedAt    time.Time               `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can          auth.Actions            `json:"can"`
}

// OutputKindAlternative says Count channels of OutputKindID act as one
// channel of the kind that has it.
type OutputKindAlternative struct {
	OutputKindID uuid.UUID `json:"outputKindId" doc:"The kind whose channels act as this kind"`
	Count        int32     `json:"count" minimum:"1" maximum:"16" doc:"How many channels of that kind make one of this kind (fixed groups: 1+2, 3+4, ...)"`
}

type OutputKindInput struct {
	Key             string                  `json:"key" doc:"Lower snake case, 1-64 characters" example:"blind_output"`
	Name            i18n.Text               `json:"name" doc:"At most 100 characters; \"en\" is required"`
	IsActive        bool                    `json:"isActive"`
	FunctionTypeIDs []uuid.UUID             `json:"functionTypeIds,omitempty" maxItems:"200" doc:"Function types it serves (existing ones, each once); left out = none"`
	Alternatives    []OutputKindAlternative `json:"alternatives,omitempty" maxItems:"50" doc:"Each other kind once; left out = none (lists of new endpoints are replaced, D306)"`
}

type OutputKindUpdate struct {
	OutputKindInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if it changed since, the update fails with output_kind.stale"`
}

// Meaning is what a catalog field's value means for the checks (D187).
type Meaning string

const (
	MeaningNone             Meaning = ""
	MeaningChannelsSupplied Meaning = "channels_supplied"
	MeaningChannelLimitW    Meaning = "channel_limit_w"
	MeaningChannelLimitA    Meaning = "channel_limit_a"
	MeaningChannelMinLoadW  Meaning = "channel_min_load_w"
	// MeaningChannelVoltage (per output kind): the voltage the channels
	// switch when it is not the product type's nominal voltage (D407).
	MeaningChannelVoltage         Meaning = "channel_voltage"
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
	// MeaningAlternativeAllowed (yes/no, output kind = the target kind): the
	// product's channels may act as that kind through its alternatives
	// (D303).
	MeaningAlternativeAllowed Meaning = "alternative_allowed"
)

// MeaningSpec describes a meaning: its parameters and the value types it
// accepts.
type MeaningSpec struct {
	Meaning          Meaning           `json:"meaning"`
	OutputKind       bool              `json:"outputKind" doc:"Needs an output kind (outputKindId)"`
	LoadType         bool              `json:"loadType" doc:"Takes a load type (loadTypeId); required only with loadTypeRequired"`
	LoadTypeRequired bool              `json:"loadTypeRequired" doc:"The load type is required"`
	Types            []attrschema.Type `json:"types" doc:"Value types a field with this meaning may have"`
	Options          []string          `json:"options" doc:"Enum fields: the option keys the field must have, exactly (motor_type: ac, dc)"`
}

var (
	numeric = []attrschema.Type{attrschema.TypeNumber, attrschema.TypeInteger}
	// Counts are whole numbers (D307); W, A, mA and TE may be decimal.
	count = []attrschema.Type{attrschema.TypeInteger}
	yesNo = []attrschema.Type{attrschema.TypeBoolean}
)

// Meanings lists every meaning with its parameters and accepted types, in
// display order.
var Meanings = []MeaningSpec{
	{Meaning: MeaningChannelsSupplied, OutputKind: true, Types: count},
	{Meaning: MeaningChannelLimitW, OutputKind: true, LoadType: true, LoadTypeRequired: true, Types: numeric},
	{Meaning: MeaningChannelLimitA, OutputKind: true, LoadType: true, Types: numeric},
	{Meaning: MeaningChannelMinLoadW, OutputKind: true, LoadType: true, Types: numeric},
	{Meaning: MeaningChannelVoltage, OutputKind: true, Types: numeric},
	{Meaning: MeaningModuleTotalA, Types: numeric},
	{Meaning: MeaningModuleTotalW, LoadType: true, Types: numeric},
	{Meaning: MeaningBusCurrentUsedMa, Types: numeric},
	{Meaning: MeaningBusCurrentSuppliedMa, Types: numeric},
	{Meaning: MeaningBusDevicesMax, Types: count},
	{Meaning: MeaningRailWidthTE, Types: numeric},
	{Meaning: MeaningEnclosureRows, Types: count},
	{Meaning: MeaningEnclosureTEPerRow, Types: numeric},
	{Meaning: MeaningWirelessPlacesSupplied, Types: count},
	{Meaning: MeaningWirelessPlaceUsed, Types: []attrschema.Type{attrschema.TypeInteger, attrschema.TypeBoolean}},
	{Meaning: MeaningZigbeeRouter, Types: yesNo},
	{Meaning: MeaningMotorType, Types: []attrschema.Type{attrschema.TypeEnum}, Options: []string{"ac", "dc"}},
	{Meaning: MeaningAlternativeAllowed, OutputKind: true, Types: yesNo},
}

func init() {
	for i := range Meanings {
		if Meanings[i].Options == nil {
			Meanings[i].Options = []string{}
		}
	}
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
	Meaning        Meaning     `json:"meaning,omitempty" enum:"channels_supplied,channel_limit_w,channel_limit_a,channel_min_load_w,channel_voltage,module_total_a,module_total_w,bus_current_used_ma,bus_current_supplied_ma,bus_devices_max,rail_width_te,enclosure_rows,enclosure_te_per_row,wireless_places_supplied,wireless_place_used,zigbee_router,motor_type,alternative_allowed" doc:"What the value means for the checks; empty = just information"`
	OutputKindID   *uuid.UUID  `json:"outputKindId,omitempty" doc:"Parameter of the channel meanings"`
	LoadTypeID     *uuid.UUID  `json:"loadTypeId,omitempty" doc:"Parameter of channel_limit_w (required) and channel_limit_a, channel_min_load_w, module_total_w (optional: empty = any load type)"`
	ProductTypeIDs []uuid.UUID `json:"productTypeIds" doc:"The meaning applies only to products of these product types; empty = all"`
	SortOrder      int32       `json:"sortOrder"`
	// InUse counts the categories that link the field (UsedBy names them);
	// its key and type are then locked (catalog_field.in_use).
	InUse     int          `json:"inUse" doc:"Categories linking the field; while > 0 its key and type cannot change and it cannot be deleted"`
	UsedBy    []FieldUser  `json:"usedBy" doc:"The categories linking the field"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can       auth.Actions `json:"can"`
}

type CatalogFieldInput struct {
	Key            string                       `json:"key" doc:"Lower snake case, 1-64 characters" example:"dimmer_outputs"`
	Label          i18n.Text                    `json:"label" doc:"At most 100 characters; \"en\" is required"`
	Type           attrschema.Type              `json:"type" enum:"text,number,integer,boolean,enum"`
	Unit           string                       `json:"unit,omitempty" doc:"Display only, at most 16 characters"`
	Options        []attrschema.AttributeOption `json:"options,omitempty" doc:"Enum fields: the allowed values (at least one)"`
	EtimFeature    string                       `json:"etimFeature,omitempty" maxLength:"20" doc:"ETIM feature code, e.g. EF000008"`
	Meaning        Meaning                      `json:"meaning,omitempty" enum:"channels_supplied,channel_limit_w,channel_limit_a,channel_min_load_w,channel_voltage,module_total_a,module_total_w,bus_current_used_ma,bus_current_supplied_ma,bus_devices_max,rail_width_te,enclosure_rows,enclosure_te_per_row,wireless_places_supplied,wireless_place_used,zigbee_router,motor_type,alternative_allowed" doc:"Leave out for just information"`
	OutputKindID   *uuid.UUID                   `json:"outputKindId,omitempty" doc:"Required by the channel meanings, else not allowed"`
	LoadTypeID     *uuid.UUID                   `json:"loadTypeId,omitempty" doc:"Required by channel_limit_w, optional for channel_limit_a, channel_min_load_w and module_total_w, else not allowed"`
	ProductTypeIDs []uuid.UUID                  `json:"productTypeIds,omitempty" maxItems:"200" doc:"Limit the meaning to these product types; empty = all"`
}

// FieldUser is a category that links a catalog field.
type FieldUser struct {
	ID   uuid.UUID `json:"id"`
	Key  string    `json:"key"`
	Name i18n.Text `json:"name"`
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
