// Package readiness answers what SnapFlow still needs before a system works
// in a project (D446). It has no tables: it reads the catalog through the
// services of the features that own it (products, categories, systems,
// functions, capabilities) and computes the items on request.
package readiness

import (
	"context"
	"slices"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// MaxRefs is the most refs an item lists; Count says how many there are.
const MaxRefs = 20

type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
	SeverityInfo    Severity = "info"
)

// Codes (D446). Product-level codes are capabilities.MissingCode values.
const (
	CodeFunctionsNone        = "functions_none"
	CodeFunctionNotServed    = "function_not_served"
	CodeFunctionNoLoadTypes  = "function_no_load_types"
	CodeFunctionNoKNXObjects = "function_no_knx_objects"
	CodeChannelKindUnused    = "channel_kind_unused"
	CodeCategoriesNoBoard    = "categories_without_mounting_board"
	CodeTopologyNone         = "topology_none"
	CodeSystemNoPowerSupply  = "system_no_power_supply"
	CodeSystemNoGateway      = "system_no_gateway"
	CodeSystemNoEnclosure    = "system_no_enclosure"
)

// Readiness is the answer of GET /api/catalog/readiness.
type Readiness struct {
	Systems []ReadinessSystem `json:"systems" doc:"One entry per active system (product type), in catalog order"`
	Global  []ReadinessItem   `json:"global" doc:"Items that concern the whole catalog"`
}

// ReadinessSystem is the readiness of one active product type.
type ReadinessSystem struct {
	ProductTypeID uuid.UUID       `json:"productTypeId"`
	Key           string          `json:"key"`
	Name          i18n.Text       `json:"name"`
	Abbreviation  string          `json:"abbreviation,omitempty"`
	Color         string          `json:"color,omitempty"`
	Topology      string          `json:"topology" enum:"bus,wireless,none"`
	Items         []ReadinessItem `json:"items" doc:"Empty = ready: nothing missing"`
}

// ReadinessItem is one thing still missing; Refs name at most MaxRefs of the Count
// entries it concerns.
type ReadinessItem struct {
	Code     string         `json:"code" enum:"functions_none,function_not_served,function_no_load_types,function_no_knx_objects,channel_kind_unused,categories_without_mounting_board,topology_none,product_bus_current_missing,system_no_power_supply,system_no_gateway,product_board_without_width,product_channels_missing,product_channel_without_limit,system_no_enclosure"`
	Severity Severity       `json:"severity" enum:"error,warning,info"`
	Count    int            `json:"count" doc:"How many entries the item concerns (refs lists at most 20)"`
	Refs     []ReadinessRef `json:"refs"`
}

// ReadinessRef names a catalog entry an item concerns.
type ReadinessRef struct {
	Kind  string    `json:"kind" enum:"product,category,function,system,channel_kind"`
	ID    uuid.UUID `json:"id"`
	Label i18n.Text `json:"label" doc:"Model number of a product, else the entry's name"`
}

type Service struct {
	products  *products.Service
	cats      *categories.Service
	types     *producttypes.Service
	functions *functiontypes.Service
	caps      *capabilities.Service
}

func NewService(p *products.Service, c *categories.Service, t *producttypes.Service, f *functiontypes.Service, caps *capabilities.Service) *Service {
	return &Service{products: p, cats: c, types: t, functions: f, caps: caps}
}

// productSeverity is the severity of each product-level code.
var productSeverity = map[capabilities.MissingCode]Severity{
	capabilities.MissingBoardWidth:   SeverityError,
	capabilities.MissingChannels:     SeverityWarning,
	capabilities.MissingBusCurrent:   SeverityWarning,
	capabilities.MissingChannelLimit: SeverityInfo,
}

// Readiness computes the readiness of the catalog: one pass over the
// available products (inactive products, categories and systems are
// skipped).
func (s *Service) Readiness(ctx context.Context) (Readiness, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return Readiness{}, err
	}
	types, err := s.types.List(ctx, false)
	if err != nil {
		return Readiness{}, err
	}
	cats, err := s.cats.List(ctx, false)
	if err != nil {
		return Readiness{}, err
	}
	functions, err := s.functions.List(ctx)
	if err != nil {
		return Readiness{}, err
	}
	reg, err := s.caps.Registry(ctx)
	if err != nil {
		return Readiness{}, err
	}
	prods, err := s.products.ReadinessProducts(ctx)
	if err != nil {
		return Readiness{}, err
	}
	return compute(types, cats, functions, reg, prods), nil
}

// items collects items in code order.
type items struct {
	order []string
	byKey map[string]*ReadinessItem
}

func (l *items) add(code string, sev Severity, ref *ReadinessRef) {
	if l.byKey == nil {
		l.byKey = map[string]*ReadinessItem{}
	}
	it := l.byKey[code]
	if it == nil {
		it = &ReadinessItem{Code: code, Severity: sev, Refs: []ReadinessRef{}}
		l.byKey[code] = it
		l.order = append(l.order, code)
	}
	if ref == nil {
		it.Count = max(it.Count, 1)
		return
	}
	it.Count++
	if len(it.Refs) < MaxRefs {
		it.Refs = append(it.Refs, *ref)
	}
}

// list returns the items, errors first, then warnings, then info, each in
// the order they were found.
func (l *items) list() []ReadinessItem {
	out := make([]ReadinessItem, 0, len(l.order))
	for _, c := range l.order {
		out = append(out, *l.byKey[c])
	}
	rank := map[Severity]int{SeverityError: 0, SeverityWarning: 1, SeverityInfo: 2}
	slices.SortStableFunc(out, func(a, b ReadinessItem) int { return rank[a.Severity] - rank[b.Severity] })
	return out
}

func compute(types []producttypes.ProductType, cats []categories.Category, functions []functiontypes.FunctionType,
	reg capabilities.Registry, prods []products.ReadinessProduct) Readiness {
	var global items
	activeKinds := map[uuid.UUID]bool{}
	for _, k := range reg.OutputKinds {
		activeKinds[k.ID] = true
	}
	knx := slices.ContainsFunc(types, func(t producttypes.ProductType) bool { return t.Addressing == "knx_individual" })
	activeFunctions := 0
	for _, f := range functions {
		if !f.IsActive {
			continue
		}
		activeFunctions++
		ref := &ReadinessRef{Kind: "function", ID: f.ID, Label: f.Name}
		if !slices.ContainsFunc(f.OutputKindIDs, func(id uuid.UUID) bool { return activeKinds[id] }) {
			global.add(CodeFunctionNotServed, SeverityError, ref)
		}
		if len(f.LoadTypeIDs) == 0 {
			global.add(CodeFunctionNoLoadTypes, SeverityInfo, ref)
		}
		if knx && len(f.KNXObjects) == 0 {
			global.add(CodeFunctionNoKNXObjects, SeverityWarning, ref)
		}
	}
	if activeFunctions == 0 {
		global.add(CodeFunctionsNone, SeverityError, nil)
	}
	// Channel kinds no channels_supplied field points at.
	pointed := map[uuid.UUID]bool{}
	for _, f := range reg.Fields {
		if f.Meaning == capabilities.MeaningChannelsSupplied && f.OutputKindID != nil {
			pointed[*f.OutputKindID] = true
		}
	}
	for _, k := range reg.OutputKinds {
		if !pointed[k.ID] {
			global.add(CodeChannelKindUnused, SeverityInfo, &ReadinessRef{Kind: "channel_kind", ID: k.ID, Label: k.Name})
		}
	}
	// Categories mounted on the floorplan whose products carry a width.
	withWidth := map[uuid.UUID]bool{}
	byType := map[uuid.UUID][]products.ReadinessProduct{}
	for _, p := range prods {
		byType[p.ProductTypeID] = append(byType[p.ProductTypeID], p)
		// Only products placed on the floorplan: an override to the board
		// already puts them there.
		if p.Capabilities.Mounting == string(capabilities.MountingFloorplan) &&
			anyCaps(p, func(c capabilities.Capabilities) bool { return c.RailWidthTE != nil }) {
			withWidth[p.CategoryID] = true
		}
	}
	for _, c := range cats {
		if withWidth[c.ID] && (c.Mounting == "" || c.Mounting == string(capabilities.MountingFloorplan)) {
			global.add(CodeCategoriesNoBoard, SeverityWarning, &ReadinessRef{Kind: "category", ID: c.ID, Label: c.Name})
		}
	}
	out := Readiness{Systems: []ReadinessSystem{}, Global: global.list()}
	for _, t := range types {
		out.Systems = append(out.Systems, ReadinessSystem{ProductTypeID: t.ID, Key: t.Key, Name: t.Name, Abbreviation: t.Abbreviation,
			Color: t.Color, Topology: t.Topology, Items: systemItems(t, byType[t.ID])})
	}
	return out
}

func systemItems(t producttypes.ProductType, prods []products.ReadinessProduct) []ReadinessItem {
	var l items
	topology := capabilities.Topology(t.Topology)
	if topology == capabilities.TopologyNone || topology == "" {
		l.add(CodeTopologyNone, SeverityInfo, nil)
	}
	var powerSupply, gateway, enclosure, onBoard bool
	for _, p := range prods {
		ref := &ReadinessRef{Kind: "product", ID: p.ID, Label: i18n.Text{"en": p.ModelNumber}}
		for _, code := range capabilities.MissingCodes {
			if p.Capabilities.HasMissing(code) {
				l.add(string(code), productSeverity[code], ref)
			}
		}
		powerSupply = powerSupply || anyCaps(p, func(c capabilities.Capabilities) bool {
			return c.BusCurrentSuppliedMa != nil && *c.BusCurrentSuppliedMa > 0
		})
		gateway = gateway || anyCaps(p, func(c capabilities.Capabilities) bool {
			return c.WirelessPlacesSupplied != nil && *c.WirelessPlacesSupplied > 0
		})
		enclosure = enclosure || anyCaps(p, func(c capabilities.Capabilities) bool {
			return c.EnclosureRows != nil && *c.EnclosureRows > 0
		})
		onBoard = onBoard || p.Capabilities.Mounting == string(capabilities.MountingBoard) ||
			p.Capabilities.Mounting == string(capabilities.MountingBoth)
	}
	if topology == capabilities.TopologyBus && !powerSupply {
		l.add(CodeSystemNoPowerSupply, SeverityWarning, nil)
	}
	if topology == capabilities.TopologyWireless && !gateway {
		l.add(CodeSystemNoGateway, SeverityWarning, nil)
	}
	if onBoard && !enclosure {
		l.add(CodeSystemNoEnclosure, SeverityInfo, nil)
	}
	return l.list()
}

// anyCaps reports whether the product or one of its active variants
// satisfies fn.
func anyCaps(p products.ReadinessProduct, fn func(capabilities.Capabilities) bool) bool {
	return fn(p.Capabilities) || slices.ContainsFunc(p.Variants, fn)
}
