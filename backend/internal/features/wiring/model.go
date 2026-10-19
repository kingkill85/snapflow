package wiring

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Connection gives units of a need to one channel of a board module or
// floorplan device (D340, D378).
type Connection struct {
	ID           uuid.UUID  `json:"id"`
	VersionID    uuid.UUID  `json:"versionId"`
	NeedPlanID   uuid.UUID  `json:"needPlanId"`
	NeedID       uuid.UUID  `json:"needId"`
	Units        int32      `json:"units" doc:"Units of the need on this channel (1-100)"`
	TargetPlanID uuid.UUID  `json:"targetPlanId" doc:"The board (module) or floorplan (device) plan"`
	TargetItemID uuid.UUID  `json:"targetItemId" doc:"The module or placement id"`
	OutputKindID uuid.UUID  `json:"outputKindId"`
	ChannelNo    int32      `json:"channelNo" doc:"1..count of the kind on the item: native channels first, then the alternative groups (D303)"`
	Pinned       bool       `json:"pinned" doc:"Made or changed by hand; auto-connect never moves it"`
	BatchID      *uuid.UUID `json:"batchId" nullable:"true" doc:"The auto-connect run that made it; null by hand"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// ConnectionActions are what the caller may do.
type ConnectionActions struct {
	Update bool `json:"update" doc:"Connect, change, disconnect, auto-connect (projects.write, project active)"`
}

// Connections are the connections of a version.
type Connections struct {
	Items []Connection      `json:"items" doc:"In creation order"`
	Can   ConnectionActions `json:"can"`
}

// ConnectionInput connects units of a need to a channel.
type ConnectionInput struct {
	NeedPlanID   uuid.UUID `json:"needPlanId"`
	NeedID       uuid.UUID `json:"needId"`
	Units        int32     `json:"units" minimum:"1" maximum:"100"`
	TargetPlanID uuid.UUID `json:"targetPlanId"`
	TargetItemID uuid.UUID `json:"targetItemId"`
	OutputKindID uuid.UUID `json:"outputKindId"`
	ChannelNo    int32     `json:"channelNo" minimum:"1" maximum:"10000"`
}

// ConnectionUpdate changes the units of a connection or moves it to another
// channel; it becomes pinned.
type ConnectionUpdate struct {
	Units        int32     `json:"units" minimum:"1" maximum:"100"`
	TargetPlanID uuid.UUID `json:"targetPlanId"`
	TargetItemID uuid.UUID `json:"targetItemId"`
	OutputKindID uuid.UUID `json:"outputKindId"`
	ChannelNo    int32     `json:"channelNo" minimum:"1" maximum:"10000"`
}

// ConnectionResult is a connection as saved with the warnings it has
// (errors refuse the save).
type ConnectionResult struct {
	Connection Connection `json:"connection"`
	Warnings   []Finding  `json:"warnings" doc:"limit_unknown, min_load"`
}

// DisconnectInput removes the connections of a need or of a channel.
type DisconnectInput struct {
	NeedPlanID   *uuid.UUID `json:"needPlanId,omitempty" doc:"With needId: every connection of the need"`
	NeedID       *uuid.UUID `json:"needId,omitempty"`
	TargetPlanID *uuid.UUID `json:"targetPlanId,omitempty" doc:"With targetItemId, outputKindId, channelNo: every connection of the channel"`
	TargetItemID *uuid.UUID `json:"targetItemId,omitempty"`
	OutputKindID *uuid.UUID `json:"outputKindId,omitempty"`
	ChannelNo    *int32     `json:"channelNo,omitempty"`
}

// Removed counts removed connections.
type Removed struct {
	Removed int64 `json:"removed"`
}

// Refs say what a finding is about; absent = not applicable.
type Refs struct {
	PlanID        *uuid.UUID  `json:"planId,omitempty" doc:"The floorplan of the zone or need"`
	ZoneID        *uuid.UUID  `json:"zoneId,omitempty"`
	NeedID        *uuid.UUID  `json:"needId,omitempty"`
	ConnectionIDs []uuid.UUID `json:"connectionIds,omitempty"`
	TargetPlanID  *uuid.UUID  `json:"targetPlanId,omitempty" doc:"The board or floorplan of the item (module, device, gateway)"`
	ItemID        *uuid.UUID  `json:"itemId,omitempty"`
	OutputKindID  *uuid.UUID  `json:"outputKindId,omitempty"`
	ChannelNo     *int        `json:"channelNo,omitempty"`
	BusLineID     *uuid.UUID  `json:"busLineId,omitempty"`
}

// Finding is one result of the checks.
type Finding struct {
	Severity Severity       `json:"severity" enum:"error,warning,info"`
	Code     string         `json:"code" doc:"See the checks codes (e.g. need_unconnected, channel_overload_w, bus_line_current_exceeded)"`
	Refs     Refs           `json:"refs"`
	Params   map[string]any `json:"params" doc:"Values for the translated message"`
}

// Status of a capacity: ok, amber (above 100 − reserve %), red (exceeded),
// unknown (nothing supplies it).
type Status string

const (
	StatusOK      Status = "ok"
	StatusAmber   Status = "amber"
	StatusRed     Status = "red"
	StatusUnknown Status = "unknown"
)

// ZoneStatus is how far the needs of a zone are connected.
type ZoneStatus struct {
	PlanID         uuid.UUID  `json:"planId"`
	ZoneID         *uuid.UUID `json:"zoneId" nullable:"true" doc:"null: needs outside every zone"`
	Name           string     `json:"name"`
	Units          int64      `json:"units" doc:"Units of the zone's needs"`
	ConnectedUnits int64      `json:"connectedUnits" doc:"Connected units, at most each need's quantity"`
	Status         string     `json:"status" enum:"covered,partial,missing,none" doc:"none: the zone has no needs"`
}

// RowUse is the TE of a board row.
type RowUse struct {
	RowID      uuid.UUID `json:"rowId"`
	Position   int32     `json:"position"`
	UsedTE     float64   `json:"usedTe" doc:"Modules' widths (unknown width = 1 TE)"`
	CapacityTE float64   `json:"capacityTe"`
	Status     Status    `json:"status" enum:"ok,amber,red,unknown" doc:"TE of the row: red over capacity (board_row_over_capacity), amber above 100 − 20 %"`
}

// ChannelUse is the channels of one output kind on a board or item.
type ChannelUse struct {
	OutputKindID  uuid.UUID `json:"outputKindId"`
	OutputKindKey string    `json:"outputKindKey"`
	Alternative   bool      `json:"alternative" doc:"Channels made of other kinds' channels (D303): total = groups possible, free = groups whose channels are all free"`
	Total         int       `json:"total"`
	Used          int       `json:"used"`
	Free          int       `json:"free"`
}

// BoardStatus is a board's channels and rows.
type BoardStatus struct {
	PlanID     uuid.UUID    `json:"planId"`
	Name       string       `json:"name"`
	Channels   []ChannelUse `json:"channels" doc:"Native kinds in output kind order, then alternatives"`
	Rows       []RowUse     `json:"rows"`
	UsedTE     float64      `json:"usedTe"`
	CapacityTE float64      `json:"capacityTe"`
	Status     Status       `json:"status" enum:"ok,amber,red,unknown" doc:"TE: red over capacity, amber above 100 − 20 % (the default reserve)"`
}

// BusLineStatus is a bus line's current and devices.
type BusLineStatus struct {
	BusLineID           uuid.UUID `json:"busLineId"`
	Name                string    `json:"name"`
	ProductTypeID       uuid.UUID `json:"productTypeId"`
	ReservePercent      int32     `json:"reservePercent"`
	CurrentUsedMa       float64   `json:"currentUsedMa" doc:"Known currents, defaults included"`
	CurrentDefaultMa    float64   `json:"currentDefaultMa" doc:"Part of currentUsedMa from the system's default"`
	CurrentSuppliedMa   float64   `json:"currentSuppliedMa"`
	UnknownCurrentCount int       `json:"unknownCurrentCount"`
	CurrentStatus       Status    `json:"currentStatus" enum:"ok,amber,red,unknown" doc:"unknown: no power supply"`
	Devices             int       `json:"devices" doc:"Members (power supplies included)"`
	DevicesMax          *int32    `json:"devicesMax,omitempty" doc:"The line's devicesMax, else the system's busDevicesMax; absent = not checked"`
	DevicesStatus       Status    `json:"devicesStatus" enum:"ok,amber,red,unknown" doc:"unknown: no limit"`
}

// GatewayStatus is a gateway's places.
type GatewayStatus struct {
	PlanID uuid.UUID `json:"planId"`
	ItemID uuid.UUID `json:"itemId"`
	Label  string    `json:"label"`
	// ProductName names a gateway without label (D417).
	ProductName    *i18n.Text `json:"productName" nullable:"true" doc:"null: the variant no longer exists"`
	ProductTypeID  uuid.UUID  `json:"productTypeId"`
	ReservePercent int32      `json:"reservePercent"`
	PlacesUsed     float64    `json:"placesUsed"`
	PlacesSupplied float64    `json:"placesSupplied"`
	UnknownCount   int        `json:"unknownCount"`
	Devices        int        `json:"devices"`
	Routers        int        `json:"routers"`
	Status         Status     `json:"status" enum:"ok,amber,red,unknown"`
}

// CheckCounts sum up the checks.
type CheckCounts struct {
	Errors         int   `json:"errors"`
	Warnings       int   `json:"warnings"`
	Infos          int   `json:"infos"`
	Units          int64 `json:"units" doc:"Units of all needs"`
	ConnectedUnits int64 `json:"connectedUnits"`
	ZonesWithNeeds int   `json:"zonesWithNeeds"`
	ZonesCovered   int   `json:"zonesCovered"`
}

// Checks is the evaluation of a version (computed on demand).
type Checks struct {
	VersionID uuid.UUID       `json:"versionId"`
	Counts    CheckCounts     `json:"counts"`
	Zones     []ZoneStatus    `json:"zones" doc:"Every zone of every floorplan in plan and zone order; needs outside zones as zoneId null last per plan"`
	Boards    []BoardStatus   `json:"boards" doc:"In plan order"`
	BusLines  []BusLineStatus `json:"busLines" doc:"In line order"`
	Gateways  []GatewayStatus `json:"gateways" doc:"In plan and item order"`
	Findings  []Finding       `json:"findings" doc:"Errors, then warnings, then infos; within a severity in a fixed order"`
}

// AutoConnectScope says which needs auto-connect handles.
type AutoConnectScope struct {
	Scope   string      `json:"scope" enum:"all,zones,needs"`
	ZoneIDs []uuid.UUID `json:"zoneIds,omitempty" maxItems:"2000" doc:"scope zones"`
	NeedIDs []uuid.UUID `json:"needIds,omitempty" maxItems:"5000" doc:"scope needs"`
}

// AutoConnectApply applies the preview.
type AutoConnectApply struct {
	AutoConnectScope
	ExpectedChecksum string `json:"expectedChecksum" doc:"checksum of the preview; anything changed since → 409 auto_connect.changed"`
}

// PlannedConnection is a connection auto-connect would make.
type PlannedConnection struct {
	NeedPlanID   uuid.UUID `json:"needPlanId"`
	NeedID       uuid.UUID `json:"needId"`
	Units        int32     `json:"units"`
	TargetPlanID uuid.UUID `json:"targetPlanId"`
	TargetItemID uuid.UUID `json:"targetItemId"`
	OutputKindID uuid.UUID `json:"outputKindId"`
	ChannelNo    int32     `json:"channelNo"`
}

// Unconnectable is a need auto-connect cannot (fully) connect.
type Unconnectable struct {
	NeedPlanID uuid.UUID      `json:"needPlanId"`
	NeedID     uuid.UUID      `json:"needId"`
	Units      int32          `json:"units" doc:"Units left unconnected"`
	Reason     string         `json:"reason" enum:"no_channel_serves,no_free_channel,limits_exceeded"`
	Params     map[string]any `json:"params" doc:"functionTypeKey"`
}

// AutoConnectPreview is what auto-connect would do.
type AutoConnectPreview struct {
	Connections    []PlannedConnection `json:"connections"`
	Unconnectable  []Unconnectable     `json:"unconnectable"`
	Needs          int                 `json:"needs" doc:"Needs in scope with unconnected units"`
	Units          int64               `json:"units" doc:"Their unconnected units"`
	ConnectedUnits int64               `json:"connectedUnits" doc:"Units the planned connections take"`
	Checksum       string              `json:"checksum" doc:"Send it back with apply"`
}

// AutoConnectResult is an applied auto-connect run.
type AutoConnectResult struct {
	BatchID     *uuid.UUID   `json:"batchId" nullable:"true" doc:"Undo with DELETE …/auto-connect/{batchId}; null when nothing was connected"`
	Connections []Connection `json:"connections"`
}
