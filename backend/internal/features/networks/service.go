// Package networks manages the networks of a project version (step 3c):
// bus lines of the bus systems (KNX, HDL Buspro) with their members, and the
// gateways of the wireless systems (Zigbee) with their devices. Members and
// devices are the placements and board modules of the version's plans, read
// through plans.Service; the catalog (system topology, capabilities, names)
// through products.Service. By default a bus device belongs to its system's
// first line and a wireless device to the gateway on the same plan, else the
// nearest by plan order (D359); explicit assignments override the defaults.
//
// The tables are tenant-owned (row-level security, database.InScope).
package networks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/networks/store"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db       DB
	q        *store.Queries
	projects *projects.Service
	plans    *plans.Service
	products *products.Service
	types    *producttypes.Service
}

// NewService wires the networks feature; it registers its plan copier (bus
// lines and assignments follow a version copy with ids kept).
func NewService(db DB, projectSvc *projects.Service, planSvc *plans.Service, productSvc *products.Service, typeSvc *producttypes.Service) *Service {
	s := &Service{db: db, q: store.New(db), projects: projectSvc, plans: planSvc, products: productSvc, types: typeSvc}
	planSvc.OnCopyPlans(s.copyPlans)
	return s
}

func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- bus lines

// ListBusLines returns the bus lines of a version in their order.
func (s *Service) ListBusLines(ctx context.Context, versionID uuid.UUID) ([]BusLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var rows []store.BusLine
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListBusLines(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := make([]BusLine, len(rows))
	for i, r := range rows {
		out[i] = lineOf(r)
	}
	return out, nil
}

// CreateBusLine adds a line to a bus system of the version.
func (s *Service) CreateBusLine(ctx context.Context, versionID uuid.UUID, in BusLineInput) (BusLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return BusLine{}, err
	}
	name, address, err := validateLine(in.Name, in.Address)
	if err != nil {
		return BusLine{}, err
	}
	t, err := s.types.Get(ctx, in.ProductTypeID)
	if err != nil {
		var ae *apperr.Error
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
			return BusLine{}, apperr.Invalid("body.productTypeId", "bus_line.product_type_not_found", "no such product type")
		}
		return BusLine{}, err
	}
	if t.Topology != TopologyBus {
		return BusLine{}, apperr.Invalid("body.productTypeId", "bus_line.not_bus_system", "the product type is not a bus system")
	}
	var row store.BusLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		row, err = q.CreateBusLine(ctx, store.CreateBusLineParams{
			TenantID: ref.TenantID, VersionID: versionID, ProductTypeID: in.ProductTypeID, Name: name, Address: address,
		})
		return mapNameErr(err, name)
	})
	if err != nil {
		return BusLine{}, err
	}
	return lineOf(row), nil
}

// UpdateBusLine renames a line or changes its address.
func (s *Service) UpdateBusLine(ctx context.Context, versionID, id uuid.UUID, in BusLineUpdate) (BusLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return BusLine{}, err
	}
	name, address, err := validateLine(in.Name, in.Address)
	if err != nil {
		return BusLine{}, err
	}
	var row store.BusLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, false); err != nil {
			return err
		}
		row, err = q.UpdateBusLine(ctx, store.UpdateBusLineParams{VersionID: versionID, ID: id, Name: name, Address: address})
		if errors.Is(err, pgx.ErrNoRows) {
			return errLineNotFound()
		}
		return mapNameErr(err, name)
	})
	if err != nil {
		return BusLine{}, err
	}
	return lineOf(row), nil
}

// DeleteBusLine removes a line; refused while items are explicitly assigned
// to it (bus_line.in_use). Members by default follow the system's first
// remaining line (D360).
func (s *Service) DeleteBusLine(ctx context.Context, versionID, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		n, err := q.BusLineAssignmentCount(ctx, store.BusLineAssignmentCountParams{VersionID: versionID, BusLineID: &id})
		if err != nil {
			return err
		}
		if n > 0 {
			return apperr.Conflict("bus_line.in_use", "devices are assigned to the line; move them first").With("count", n)
		}
		deleted, err := q.DeleteBusLine(ctx, store.DeleteBusLineParams{VersionID: versionID, ID: id})
		if err != nil {
			return err
		}
		if deleted == 0 {
			return errLineNotFound()
		}
		return nil
	})
}

// ReorderBusLines sets the order of a version's lines; ids must list every
// line of the version exactly once (bus_line.order_mismatch).
func (s *Service) ReorderBusLines(ctx context.Context, versionID uuid.UUID, ids []uuid.UUID) ([]BusLine, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return nil, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		rows, err := q.ListBusLines(ctx, versionID)
		if err != nil {
			return err
		}
		if !sameSet(ids, rows) {
			return apperr.New(http.StatusUnprocessableEntity, "bus_line.order_mismatch", "ids must list every line of the version exactly once")
		}
		return q.SetBusLineOrder(ctx, store.SetBusLineOrderParams{Ids: ids, VersionID: versionID})
	})
	if err != nil {
		return nil, err
	}
	return s.ListBusLines(ctx, versionID)
}

// ---------------------------------------------------------------- networks

// state is what a networks view is computed from.
type state struct {
	ref         projects.VersionRef
	plans       []plans.NetworkPlan
	lines       []store.BusLine
	assignments map[[2]uuid.UUID]store.NetworkAssignment
	variants    map[uuid.UUID]products.BOMVariant
	caps        map[uuid.UUID]capabilities.Capabilities
}

func (s *Service) load(ctx context.Context, actor auth.Actor, versionID uuid.UUID) (state, error) {
	var st state
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if st.ref, err = s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		return st.read(ctx, s, tx, q)
	})
	if err != nil {
		return st, err
	}
	// The catalog after the transaction (D243).
	var ids []uuid.UUID
	for _, p := range st.plans {
		for _, it := range p.Items {
			if it.VariantID != nil {
				ids = append(ids, *it.VariantID)
			}
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	ids = slices.Compact(ids)
	if st.variants, err = s.products.BOMVariants(ctx, ids); err != nil {
		return st, err
	}
	st.caps = map[uuid.UUID]capabilities.Capabilities{}
	if len(ids) > 0 {
		if st.caps, err = s.products.Capabilities(ctx, ids); err != nil {
			return st, err
		}
	}
	return st, nil
}

func (st *state) read(ctx context.Context, s *Service, tx pgx.Tx, q *store.Queries) error {
	var err error
	if st.plans, err = s.plans.NetworkItems(ctx, tx, st.ref.ID); err != nil {
		return err
	}
	if st.lines, err = q.ListBusLines(ctx, st.ref.ID); err != nil {
		return err
	}
	rows, err := q.ListAssignments(ctx, st.ref.ID)
	if err != nil {
		return err
	}
	st.assignments = make(map[[2]uuid.UUID]store.NetworkAssignment, len(rows))
	for _, a := range rows {
		st.assignments[[2]uuid.UUID{a.PlanID, a.ItemID}] = a
	}
	return nil
}

// item is a placement or module with its catalog facts.
type item struct {
	ref     ItemRef
	planPos int
	system  uuid.UUID
	topo    string
	caps    capabilities.Capabilities
	gateway bool
}

// items lists the version's items that belong to a bus or wireless system,
// in plan and item order.
func (st *state) items() []item {
	var out []item
	for pi, p := range st.plans {
		for _, it := range p.Items {
			if it.VariantID == nil {
				continue
			}
			v, ok := st.variants[*it.VariantID]
			if !ok || (v.ProductType.Topology != TopologyBus && v.ProductType.Topology != TopologyWireless) {
				continue
			}
			c := st.caps[*it.VariantID]
			out = append(out, item{
				ref: ItemRef{
					PlanID: p.ID, PlanName: p.Name, PlanKind: p.Kind, ItemID: it.ID, Label: it.Label, VariantID: *it.VariantID,
					ProductName: v.ProductName, VariantName: v.VariantName, ModelNumber: v.ModelNumber, Existing: it.Existing,
				},
				planPos: pi, system: v.ProductType.ID, topo: v.ProductType.Topology, caps: c,
				gateway: v.ProductType.Topology == TopologyWireless && c.WirelessPlacesSupplied != nil && *c.WirelessPlacesSupplied > 0,
			})
		}
	}
	return out
}

// Get returns the networks of a version. A bus system with members but no
// line gets its default line first (when the caller may change the
// version, D358).
func (s *Service) Get(ctx context.Context, versionID uuid.UUID) (Networks, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Networks{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Networks{}, err
	}
	can := actor.Can(auth.PermProjectsWrite) && st.ref.Writable()
	if can {
		created, err := s.ensureDefaultLines(ctx, actor, st)
		if err != nil {
			return Networks{}, err
		}
		if created {
			if st, err = s.load(ctx, actor, versionID); err != nil {
				return Networks{}, err
			}
		}
	}
	return st.view(can), nil
}

// ensureDefaultLines creates the default line of every bus system that has
// members but no line; reports whether it created any.
func (s *Service) ensureDefaultLines(ctx context.Context, actor auth.Actor, st state) (bool, error) {
	has := map[uuid.UUID]bool{}
	for _, l := range st.lines {
		has[l.ProductTypeID] = true
	}
	var missing []uuid.UUID
	names := map[uuid.UUID]string{}
	for _, it := range st.items() {
		if it.topo == TopologyBus && !has[it.system] && !slices.Contains(missing, it.system) {
			missing = append(missing, it.system)
			names[it.system] = defaultLineName(st.variants[it.ref.VariantID].ProductType)
		}
	}
	if len(missing) == 0 {
		return false, nil
	}
	err := s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, st.ref.ID, true)
		if err != nil {
			return err
		}
		lines, err := q.ListBusLines(ctx, st.ref.ID)
		if err != nil {
			return err
		}
		for _, system := range missing {
			if slices.ContainsFunc(lines, func(l store.BusLine) bool { return l.ProductTypeID == system }) {
				continue // created concurrently
			}
			if _, err := q.CreateBusLine(ctx, store.CreateBusLineParams{
				TenantID: ref.TenantID, VersionID: st.ref.ID, ProductTypeID: system, Name: names[system],
			}); err != nil {
				return err
			}
		}
		return nil
	})
	return err == nil, err
}

// defaultLineName is the name of a system's default line: its badge (or
// key) and 1, e.g. "KNX 1" (data, not UI text: the user renames it).
func defaultLineName(t producttypes.ProductType) string {
	base := t.Abbreviation
	if base == "" {
		base = strings.ToUpper(t.Key)
	}
	return base + " 1"
}

// view computes the networks from the state.
func (st state) view(can bool) Networks {
	out := Networks{VersionID: st.ref.ID, BusSystems: []BusSystem{}, WirelessSystems: []WirelessSystem{}, Can: NetworkActions{Update: can}}
	items := st.items()
	systems := map[uuid.UUID]producttypes.ProductType{}
	for _, it := range items {
		systems[it.system] = st.variants[it.ref.VariantID].ProductType
	}

	// Bus systems: every system with a line or a member.
	busIndex := map[uuid.UUID]int{}
	lineIndex := map[uuid.UUID][2]int{}
	addBus := func(id uuid.UUID) int {
		if i, ok := busIndex[id]; ok {
			return i
		}
		ref := SystemRef{ID: id}
		if t, ok := systems[id]; ok {
			ref = SystemRef{ID: t.ID, Key: t.Key, Name: t.Name, Abbreviation: t.Abbreviation, Color: t.Color}
		}
		out.BusSystems = append(out.BusSystems, BusSystem{ProductType: ref, Lines: []BusLineNetwork{}, Unassigned: []BusMember{}})
		busIndex[id] = len(out.BusSystems) - 1
		return busIndex[id]
	}
	for _, l := range st.lines {
		i := addBus(l.ProductTypeID)
		out.BusSystems[i].Lines = append(out.BusSystems[i].Lines, BusLineNetwork{BusLine: lineOf(l), Members: []BusMember{}})
		lineIndex[l.ID] = [2]int{i, len(out.BusSystems[i].Lines) - 1}
	}
	for _, it := range items {
		if it.topo != TopologyBus {
			continue
		}
		i := addBus(it.system)
		m := BusMember{
			ItemRef: it.ref, BusCurrentUsedMa: it.caps.BusCurrentUsedMa, BusCurrentUsedMaDefault: it.caps.BusCurrentUsedMaDefault,
			BusCurrentSuppliedMa: it.caps.BusCurrentSuppliedMa,
			PowerSupply:          it.caps.BusCurrentSuppliedMa != nil && *it.caps.BusCurrentSuppliedMa > 0,
		}
		target := -1
		if a, ok := st.assignments[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}]; ok && a.BusLineID != nil {
			if li, ok := lineIndex[*a.BusLineID]; ok && li[0] == i {
				target, m.Pinned = li[1], true
			}
		}
		if target < 0 && len(out.BusSystems[i].Lines) > 0 {
			target = 0
		}
		if target < 0 {
			out.BusSystems[i].Unassigned = append(out.BusSystems[i].Unassigned, m)
			continue
		}
		line := &out.BusSystems[i].Lines[target]
		line.Members = append(line.Members, m)
		line.DeviceCount++
		if m.PowerSupply {
			line.BusCurrentSuppliedMa += *m.BusCurrentSuppliedMa
		}
		switch {
		case m.BusCurrentUsedMa != nil:
			line.BusCurrentUsedMa += *m.BusCurrentUsedMa
		case !m.PowerSupply:
			line.UnknownCurrentCount++
		}
	}

	// Wireless systems: gateways first, then the devices.
	wIndex := map[uuid.UUID]int{}
	gateways := map[[2]uuid.UUID]gwPos{}
	var gwList []gwPos
	addWireless := func(id uuid.UUID) int {
		if i, ok := wIndex[id]; ok {
			return i
		}
		t := systems[id]
		out.WirelessSystems = append(out.WirelessSystems, WirelessSystem{
			ProductType: SystemRef{ID: t.ID, Key: t.Key, Name: t.Name, Abbreviation: t.Abbreviation, Color: t.Color},
			Gateways:    []Gateway{}, Unassigned: []WirelessDevice{},
		})
		wIndex[id] = len(out.WirelessSystems) - 1
		return wIndex[id]
	}
	for _, it := range items {
		if !it.gateway {
			continue
		}
		i := addWireless(it.system)
		out.WirelessSystems[i].Gateways = append(out.WirelessSystems[i].Gateways, Gateway{
			ItemRef: it.ref, WirelessPlacesSupplied: *it.caps.WirelessPlacesSupplied, Devices: []WirelessDevice{},
		})
		g := gwPos{sys: i, gw: len(out.WirelessSystems[i].Gateways) - 1, planPos: it.planPos, planID: it.ref.PlanID}
		gateways[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}] = g
		gwList = append(gwList, g)
	}
	for _, it := range items {
		if it.topo != TopologyWireless || it.gateway {
			continue
		}
		i := addWireless(it.system)
		d := WirelessDevice{ItemRef: it.ref, WirelessPlacesUsed: it.caps.WirelessPlacesUsed, WirelessPlacesUsedDefault: it.caps.WirelessPlacesUsedDefault}
		target := -1
		if a, ok := st.assignments[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}]; ok && a.GatewayPlanID != nil && a.GatewayItemID != nil {
			if g, ok := gateways[[2]uuid.UUID{*a.GatewayPlanID, *a.GatewayItemID}]; ok && g.sys == i {
				target, d.Pinned = g.gw, true
			}
		}
		if target < 0 {
			target = defaultGateway(gwList, i, it.ref.PlanID, it.planPos)
		}
		if target < 0 {
			out.WirelessSystems[i].Unassigned = append(out.WirelessSystems[i].Unassigned, d)
			continue
		}
		g := &out.WirelessSystems[i].Gateways[target]
		g.Devices = append(g.Devices, d)
		if d.WirelessPlacesUsed != nil {
			g.WirelessPlacesUsed += *d.WirelessPlacesUsed
		} else {
			g.UnknownPlacesCount++
		}
	}
	sortSystems := func(id uuid.UUID) int32 { return systems[id].SortOrder }
	slices.SortStableFunc(out.BusSystems, func(a, b BusSystem) int { return int(sortSystems(a.ProductType.ID) - sortSystems(b.ProductType.ID)) })
	slices.SortStableFunc(out.WirelessSystems, func(a, b WirelessSystem) int {
		return int(sortSystems(a.ProductType.ID) - sortSystems(b.ProductType.ID))
	})
	return out
}

// defaultGateway picks a wireless device's gateway (D359): the first
// gateway of its system on the same plan, else the nearest by plan order
// (the earlier plan on a tie), which is also the first when all are equally
// far. -1 without gateways.
// gwPos is a gateway: its system and gateway index in the view, its plan.
type gwPos struct {
	sys, gw, planPos int
	planID           uuid.UUID
}

func defaultGateway(list []gwPos, system int, planID uuid.UUID, planPos int) int {
	best, bestDist, bestPos := -1, 0, 0
	for _, g := range list {
		if g.sys != system {
			continue
		}
		if g.planID == planID {
			return g.gw
		}
		d := g.planPos - planPos
		if d < 0 {
			d = -d
		}
		if best < 0 || d < bestDist || (d == bestDist && g.planPos < bestPos) {
			best, bestDist, bestPos = g.gw, d, g.planPos
		}
	}
	return best
}

// ---------------------------------------------------------------- assignments

// SetAssignments sets or clears explicit assignments and returns the
// networks.
func (s *Service) SetAssignments(ctx context.Context, versionID uuid.UUID, in AssignmentsInput) (Networks, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Networks{}, err
	}
	if len(in.Assignments) > MaxAssignments {
		return Networks{}, apperr.Validation(apperr.Field("body.assignments", "validation.too_many", "too many assignments").With("max", MaxAssignments))
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Networks{}, err
	}
	if !st.ref.Writable() {
		return Networks{}, apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
	}
	byKey := map[[2]uuid.UUID]item{}
	for _, it := range st.items() {
		byKey[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}] = it
	}
	lines := map[uuid.UUID]store.BusLine{}
	for _, l := range st.lines {
		lines[l.ID] = l
	}
	var errs []apperr.FieldError
	for i, a := range in.Assignments {
		loc := fmt.Sprintf("body.assignments[%d]", i)
		it, ok := byKey[[2]uuid.UUID{a.PlanID, a.ItemID}]
		if !ok {
			errs = append(errs, apperr.Field(loc+".itemId", "network.item_not_found", "no bus or wireless item of the version"))
			continue
		}
		switch {
		case a.BusLineID != nil && (a.GatewayPlanID != nil || a.GatewayItemID != nil):
			errs = append(errs, apperr.Field(loc, "network.both_targets", "give a line or a gateway, not both"))
		case a.BusLineID != nil:
			l, ok := lines[*a.BusLineID]
			switch {
			case it.topo != TopologyBus:
				errs = append(errs, apperr.Field(loc+".busLineId", "network.not_bus_device", "the item is not a bus device"))
			case !ok:
				errs = append(errs, apperr.Field(loc+".busLineId", "bus_line.not_found", "no such line in the version"))
			case l.ProductTypeID != it.system:
				errs = append(errs, apperr.Field(loc+".busLineId", "network.line_mismatch", "the line belongs to another system"))
			}
		case (a.GatewayPlanID == nil) != (a.GatewayItemID == nil):
			errs = append(errs, apperr.Field(loc+".gatewayItemId", "network.gateway_partial", "give gatewayPlanId and gatewayItemId"))
		case a.GatewayPlanID != nil:
			g, ok := byKey[[2]uuid.UUID{*a.GatewayPlanID, *a.GatewayItemID}]
			switch {
			case it.topo != TopologyWireless || it.gateway:
				errs = append(errs, apperr.Field(loc+".gatewayItemId", "network.not_wireless_device", "the item is not a wireless device"))
			case !ok || !g.gateway || g.system != it.system:
				errs = append(errs, apperr.Field(loc+".gatewayItemId", "network.gateway_not_found", "no gateway of the item's system"))
			}
		}
	}
	if len(errs) > 0 {
		return Networks{}, apperr.Validation(errs...)
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		for _, a := range in.Assignments {
			if a.BusLineID == nil && a.GatewayPlanID == nil {
				if err := q.DeleteAssignment(ctx, store.DeleteAssignmentParams{PlanID: a.PlanID, ItemID: a.ItemID}); err != nil {
					return err
				}
				continue
			}
			err := q.UpsertAssignment(ctx, store.UpsertAssignmentParams{
				TenantID: ref.TenantID, VersionID: versionID, PlanID: a.PlanID, ItemID: a.ItemID, BusLineID: a.BusLineID,
				GatewayPlanID: a.GatewayPlanID, GatewayItemID: a.GatewayItemID,
			})
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				// A plan or line deleted since the check.
				return apperr.Conflict("network.changed", "the plan or line was changed meanwhile; reload")
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Networks{}, err
	}
	return s.Get(ctx, versionID)
}

// ---------------------------------------------------------------- copy

// copyPlans copies the bus lines (ids kept) and the assignments (plan ids
// mapped) of a version copy (plans.Service.OnCopyPlans).
func (s *Service) copyPlans(ctx context.Context, tx pgx.Tx, planIDs map[uuid.UUID]uuid.UUID, source, target projects.VersionRef) error {
	if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
		return err
	}
	q := s.q.WithTx(tx)
	if err := q.CopyBusLines(ctx, store.CopyBusLinesParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID}); err != nil {
		return err
	}
	m := make(map[string]string, len(planIDs))
	for k, v := range planIDs {
		m[k.String()] = v.String()
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return q.CopyAssignments(ctx, store.CopyAssignmentsParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID, PlanMap: data})
}

// ---------------------------------------------------------------- helpers

func lineOf(r store.BusLine) BusLine {
	return BusLine{
		ID: r.ID, VersionID: r.VersionID, ProductTypeID: r.ProductTypeID, Name: r.Name, Address: r.Address, Position: r.Position,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func validateLine(name, address string) (string, string, error) {
	name, address = strings.TrimSpace(name), strings.TrimSpace(address)
	var errs []apperr.FieldError
	switch {
	case name == "":
		errs = append(errs, apperr.Field("body.name", "validation.required", "required"))
	case len([]rune(name)) > MaxNameLength:
		errs = append(errs, apperr.Field("body.name", "validation.too_long", "too long").With("max", MaxNameLength))
	case strings.ContainsFunc(name, unicode.IsControl):
		errs = append(errs, apperr.Field("body.name", "validation.control_chars", "control characters are not allowed"))
	}
	switch {
	case len([]rune(address)) > MaxAddressLength:
		errs = append(errs, apperr.Field("body.address", "validation.too_long", "too long").With("max", MaxAddressLength))
	case strings.ContainsFunc(address, unicode.IsControl):
		errs = append(errs, apperr.Field("body.address", "validation.control_chars", "control characters are not allowed"))
	}
	if len(errs) > 0 {
		return "", "", apperr.Validation(errs...)
	}
	return name, address, nil
}

func sameSet(ids []uuid.UUID, rows []store.BusLine) bool {
	if len(ids) != len(rows) {
		return false
	}
	want := make(map[uuid.UUID]bool, len(rows))
	for _, r := range rows {
		want[r.ID] = true
	}
	for _, id := range ids {
		if !want[id] {
			return false
		}
		delete(want, id)
	}
	return true
}

func mapNameErr(err error, name string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "bus_lines_name_key" {
		return apperr.Conflict("bus_line.name_taken", "the system already has a line of this name").With("name", name)
	}
	return err
}

func errLineNotFound() *apperr.Error { return apperr.NotFound("bus_line.not_found") }
