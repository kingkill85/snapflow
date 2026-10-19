package networks

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Limits.
const (
	MaxNameLength    = 100
	MaxAddressLength = 50
	MaxAssignments   = 1000
	TopologyBus      = "bus"
	TopologyWireless = "wireless"
)

// BusLine is a line of a bus system (KNX line, HDL subnet) in a version.
type BusLine struct {
	ID            uuid.UUID `json:"id" doc:"Kept by the version copy"`
	VersionID     uuid.UUID `json:"versionId"`
	ProductTypeID uuid.UUID `json:"productTypeId" doc:"The bus system (product type with topology bus)"`
	Name          string    `json:"name"`
	Address       string    `json:"address" doc:"KNX area/line or HDL subnet for later programming; empty for none"`
	Position      int32     `json:"position" doc:"Order within the version, 1 first"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// BusLineInput creates a bus line.
type BusLineInput struct {
	ProductTypeID uuid.UUID `json:"productTypeId" doc:"A product type with topology bus"`
	Name          string    `json:"name" doc:"1-100 characters, unique per system in the version ignoring case"`
	Address       string    `json:"address,omitempty" doc:"At most 50 characters"`
}

// BusLineUpdate renames a bus line or changes its address.
type BusLineUpdate struct {
	Name    string `json:"name" doc:"1-100 characters, unique per system in the version ignoring case"`
	Address string `json:"address" doc:"At most 50 characters; empty for none"`
}

// SystemRef names a product type (system).
type SystemRef struct {
	ID           uuid.UUID `json:"id"`
	Key          string    `json:"key"`
	Name         i18n.Text `json:"name"`
	Abbreviation string    `json:"abbreviation,omitempty"`
	Color        string    `json:"color,omitempty"`
}

// ItemRef is a placement (floorplan) or module (board) of the version.
type ItemRef struct {
	PlanID      uuid.UUID  `json:"planId"`
	PlanName    string     `json:"planName"`
	PlanKind    string     `json:"planKind" enum:"floorplan,board"`
	ItemID      uuid.UUID  `json:"itemId" doc:"The placement or module id"`
	Label       string     `json:"label"`
	VariantID   uuid.UUID  `json:"variantId"`
	ProductName i18n.Text  `json:"productName"`
	VariantName i18n.Text  `json:"variantName"`
	ModelNumber string     `json:"modelNumber"`
	Existing    bool       `json:"existing"`
}

// BusMember is a bus device on a line.
type BusMember struct {
	ItemRef
	BusCurrentUsedMa        *float64 `json:"busCurrentUsedMa,omitempty" doc:"Absent when unknown"`
	BusCurrentUsedMaDefault bool     `json:"busCurrentUsedMaDefault" doc:"busCurrentUsedMa is the system's default"`
	BusCurrentSuppliedMa    *float64 `json:"busCurrentSuppliedMa,omitempty" doc:"Set for a power supply"`
	PowerSupply             bool     `json:"powerSupply" doc:"Supplies bus current (busCurrentSuppliedMa > 0)"`
	Pinned                  bool     `json:"pinned" doc:"Explicitly assigned; false = the default (the system's first line)"`
}

// BusLineNetwork is a line with its members and informational totals (the
// checks with reserve come in 3d).
type BusLineNetwork struct {
	BusLine
	Members              []BusMember `json:"members"`
	DeviceCount          int         `json:"deviceCount"`
	BusCurrentUsedMa     float64     `json:"busCurrentUsedMa" doc:"Sum of the known currents used"`
	BusCurrentSuppliedMa float64     `json:"busCurrentSuppliedMa" doc:"Sum of the power supplies' currents"`
	UnknownCurrentCount  int         `json:"unknownCurrentCount" doc:"Members without a known current used (power supplies excluded)"`
}

// BusSystem is a bus system of the version with its lines.
type BusSystem struct {
	ProductType SystemRef        `json:"productType"`
	Lines       []BusLineNetwork `json:"lines" doc:"In order; the first is the default line"`
	Unassigned  []BusMember      `json:"unassigned" doc:"Members without a line (only while the system has no line yet: read-only projects or readers)"`
}

// WirelessDevice is a wireless device assigned to a gateway.
type WirelessDevice struct {
	ItemRef
	WirelessPlacesUsed        *float64 `json:"wirelessPlacesUsed,omitempty" doc:"Absent when unknown"`
	WirelessPlacesUsedDefault bool     `json:"wirelessPlacesUsedDefault"`
	Pinned                    bool     `json:"pinned" doc:"Explicitly assigned; false = the default gateway"`
}

// Gateway is an item that supplies wireless places, with its devices.
type Gateway struct {
	ItemRef
	WirelessPlacesSupplied float64          `json:"wirelessPlacesSupplied"`
	WirelessPlacesUsed     float64          `json:"wirelessPlacesUsed" doc:"Sum of the known places its devices use"`
	UnknownPlacesCount     int              `json:"unknownPlacesCount"`
	Devices                []WirelessDevice `json:"devices"`
}

// WirelessSystem is a wireless system of the version with its gateways.
type WirelessSystem struct {
	ProductType SystemRef        `json:"productType"`
	Gateways    []Gateway        `json:"gateways" doc:"In plan and item order"`
	Unassigned  []WirelessDevice `json:"unassigned" doc:"Devices while the system has no gateway"`
}

// NetworkActions are what the caller may do.
type NetworkActions struct {
	Update bool `json:"update" doc:"Manage bus lines and assignments (projects.write, project active)"`
}

// Networks is the bus lines and gateways of a version.
type Networks struct {
	VersionID       uuid.UUID        `json:"versionId"`
	BusSystems      []BusSystem      `json:"busSystems" doc:"In product type order"`
	WirelessSystems []WirelessSystem `json:"wirelessSystems" doc:"In product type order"`
	Can             NetworkActions   `json:"can"`
}

// AssignmentInput sets or clears the explicit assignment of an item. Both
// targets null clears it (the item falls back to its default).
type AssignmentInput struct {
	PlanID        uuid.UUID  `json:"planId"`
	ItemID        uuid.UUID  `json:"itemId"`
	BusLineID     *uuid.UUID `json:"busLineId,omitempty" nullable:"true" doc:"A line of the item's bus system"`
	GatewayPlanID *uuid.UUID `json:"gatewayPlanId,omitempty" nullable:"true" doc:"With gatewayItemId: a gateway of the item's wireless system"`
	GatewayItemID *uuid.UUID `json:"gatewayItemId,omitempty" nullable:"true"`
}

// AssignmentsInput is a batch of assignment changes.
type AssignmentsInput struct {
	Assignments []AssignmentInput `json:"assignments" maxItems:"1000"`
}
