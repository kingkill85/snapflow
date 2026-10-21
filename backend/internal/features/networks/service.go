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
// lines and assignments follow a version copy with ids kept) and its content
// hook (a content save creates the default line of a bus system, D372).
func NewService(db DB, projectSvc *projects.Service, planSvc *plans.Service, productSvc *products.Service, typeSvc *producttypes.Service) *Service {
	s := &Service{db: db, q: store.New(db), projects: projectSvc, plans: planSvc, products: productSvc, types: typeSvc}
	planSvc.OnCopyPlans(s.copyPlans)
	planSvc.OnContentSave(s.defaultLinesHook())
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
	name, address, err := validateLine(in.Name, in.Address, in.DevicesMax)
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
	if !t.IsActive {
		return BusLine{}, apperr.Invalid("body.productTypeId", "bus_line.product_type_inactive", "the product type is inactive")
	}
	if err := validateLineAddress(t, address); err != nil {
		return BusLine{}, err
	}
	var row store.BusLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		// The project's types as of this transaction (the project is locked).
		if !slices.Contains(ref.ProductTypeIDs, in.ProductTypeID) {
			return apperr.Invalid("body.productTypeId", "bus_line.product_type_not_in_project", "the project does not use this product type")
		}
		row, err = q.CreateBusLine(ctx, store.CreateBusLineParams{
			TenantID: ref.TenantID, VersionID: versionID, ProductTypeID: in.ProductTypeID, Name: name, Address: address,
			DevicesMax: in.DevicesMax,
		})
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return apperr.Invalid("body.productTypeId", "bus_line.product_type_not_found", "no such product type")
		}
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
	name, address, err := validateLine(in.Name, in.Address, in.DevicesMax)
	if err != nil {
		return BusLine{}, err
	}
	if address != "" {
		// The line's system decides the address format; read before the
		// write transaction (the catalog outside it, D243). The system of a
		// line never changes.
		var cur store.BusLine
		err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
			if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
				return err
			}
			var err error
			cur, err = q.GetBusLine(ctx, store.GetBusLineParams{VersionID: versionID, ID: id})
			if errors.Is(err, pgx.ErrNoRows) {
				return errLineNotFound()
			}
			return err
		})
		if err != nil {
			return BusLine{}, err
		}
		if address != cur.Address {
			t, err := s.types.Get(ctx, cur.ProductTypeID)
			if err != nil {
				return BusLine{}, err
			}
			if err := validateLineAddress(t, address); err != nil {
				return BusLine{}, err
			}
		}
	}
	var row store.BusLine
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, false); err != nil {
			return err
		}
		row, err = q.UpdateBusLine(ctx, store.UpdateBusLineParams{VersionID: versionID, ID: id, Name: name, Address: address, DevicesMax: in.DevicesMax})
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

// DeleteBusLine removes a line; refused while current members are pinned
// to it (bus_line.in_use, D373): explicit assignments of items that are
// still members of the line's system. Dangling assignments (item removed,
// product changed) do not count and go with the line. Members by default
// follow the system's first remaining line (D360). The last line of a
// system with devices is refused (bus_line.last_with_devices, D451).
func (s *Service) DeleteBusLine(ctx context.Context, versionID, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return err
	}
	pinned := map[[2]uuid.UUID]bool{}
	for _, m := range st.members() {
		if m.Pinned && m.LineID != nil && *m.LineID == id {
			pinned[[2]uuid.UUID{m.PlanID, m.ItemID}] = true
		}
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		// The last line of a system with devices stays (D451): the
		// devices would be without a line until the next plan save. The
		// lines and items as of this transaction (the version is locked;
		// content saves create default lines under LockVersionLines), the
		// catalog from the snapshot (D243): items of variants unknown to
		// it (placed after the read) do not count.
		if err := q.LockVersionLines(ctx, versionID); err != nil {
			return err
		}
		lines, err := q.ListBusLines(ctx, versionID)
		if err != nil {
			return err
		}
		var system uuid.UUID
		others := 0
		for _, l := range lines {
			if l.ID == id {
				system = l.ProductTypeID
			}
		}
		for _, l := range lines {
			if l.ID != id && l.ProductTypeID == system {
				others++
			}
		}
		if system != uuid.Nil && others == 0 {
			planItems, err := s.plans.NetworkItems(ctx, tx, versionID)
			if err != nil {
				return err
			}
			devices := 0
			for _, p := range planItems {
				for _, it := range p.Items {
					if it.VariantID == nil {
						continue
					}
					if v, ok := st.variants[*it.VariantID]; ok && v.ProductType.Topology == TopologyBus && v.ProductType.ID == system {
						devices++
					}
				}
			}
			if devices > 0 {
				return apperr.Conflict("bus_line.last_with_devices", "the system's last line cannot be deleted while it has devices").With("count", devices)
			}
		}
		rows, err := q.ListLineAssignments(ctx, store.ListLineAssignmentsParams{VersionID: versionID, BusLineID: &id})
		if err != nil {
			return err
		}
		n := 0
		for _, a := range rows {
			key := [2]uuid.UUID{a.PlanID, a.ItemID}
			prev, known := st.assignments[key]
			// An assignment made after the snapshot counts (conservative).
			if pinned[key] || !known || prev.BusLineID == nil || *prev.BusLineID != id {
				n++
			}
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
	// types are all product types (also inactive), by id: names, badges
	// and order of systems that have lines but no members.
	types map[uuid.UUID]producttypes.ProductType
	// addresses are the stored device addresses (3e), by (plan, item).
	addresses map[[2]uuid.UUID]store.DeviceAddress
	// loaded are the variant ids the catalog was loaded for.
	loaded map[uuid.UUID]bool
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
	st.loaded = make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		st.loaded[id] = true
	}
	if st.variants, err = s.products.BOMVariants(ctx, ids); err != nil {
		return st, err
	}
	st.caps = map[uuid.UUID]capabilities.Capabilities{}
	if len(ids) > 0 {
		if st.caps, err = s.products.Capabilities(ctx, ids); err != nil {
			return st, err
		}
	}
	types, err := s.types.List(ctx, true)
	if err != nil {
		return st, err
	}
	st.types = make(map[uuid.UUID]producttypes.ProductType, len(types))
	for _, t := range types {
		st.types[t.ID] = t
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
	addrs, err := q.ListAddresses(ctx, st.ref.ID)
	if err != nil {
		return err
	}
	st.addresses = make(map[[2]uuid.UUID]store.DeviceAddress, len(addrs))
	for _, a := range addrs {
		st.addresses[[2]uuid.UUID{a.PlanID, a.ItemID}] = a
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
					ProductName: v.ProductName, VariantName: v.VariantName, ModelNumber: v.ModelNumber, Existing: it.Existing, ZoneID: it.ZoneID,
				},
				planPos: pi, system: v.ProductType.ID, topo: v.ProductType.Topology, caps: c,
				gateway: v.ProductType.Topology == TopologyWireless && c.WirelessPlacesSupplied != nil && *c.WirelessPlacesSupplied > 0,
			})
		}
	}
	return out
}

// Get returns the networks of a version. It never writes: a bus system
// whose members have no line yet lists them in unassigned (D372).
func (s *Service) Get(ctx context.Context, versionID uuid.UUID) (Networks, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Networks{}, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return Networks{}, err
	}
	return st.view(actor.Can(auth.PermProjectsWrite) && st.ref.Writable()), nil
}

// Membership returns where every bus and wireless item of a version
// belongs (the rule the view, line deletes and 3d's checks share).
func (s *Service) Membership(ctx context.Context, versionID uuid.UUID) ([]Member, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	st, err := s.load(ctx, actor, versionID)
	if err != nil {
		return nil, err
	}
	return st.members(), nil
}

// Member is a bus or wireless item of a version and where it belongs.
type Member struct {
	PlanID, ItemID uuid.UUID
	// SystemID is the item's product type; Topology bus or wireless.
	SystemID uuid.UUID
	Topology string
	// Gateway: a wireless item that supplies places (never a device).
	Gateway bool
	// LineID is a bus item's line: its explicit one, else the system's
	// first line; nil while the system has no line.
	LineID *uuid.UUID
	// GatewayPlanID/GatewayItemID are a wireless device's gateway: its
	// explicit one, else the default (D359); nil without a gateway.
	GatewayPlanID, GatewayItemID *uuid.UUID
	// Pinned: the line or gateway is an explicit assignment.
	Pinned bool
	// Dangling: an explicit assignment that no longer applies ("bus_line":
	// the line is gone or of another system; "gateway": the gateway is
	// gone or of another system); the default applies instead (D411).
	Dangling string
	// item is the view's data of the item.
	item item
}

// members applies the membership rule to the state's items, in plan and
// item order.
func (st state) members() []Member {
	items := st.items()
	firstLine := map[uuid.UUID]uuid.UUID{}
	lineSystem := map[uuid.UUID]uuid.UUID{}
	for _, l := range st.lines { // in line order
		lineSystem[l.ID] = l.ProductTypeID
		if _, ok := firstLine[l.ProductTypeID]; !ok {
			firstLine[l.ProductTypeID] = l.ID
		}
	}
	var gws []item
	gwSystem := map[[2]uuid.UUID]uuid.UUID{}
	for _, it := range items {
		if it.gateway {
			gws = append(gws, it)
			gwSystem[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}] = it.system
		}
	}
	out := make([]Member, 0, len(items))
	for _, it := range items {
		m := Member{PlanID: it.ref.PlanID, ItemID: it.ref.ItemID, SystemID: it.system, Topology: it.topo, Gateway: it.gateway, item: it}
		a, assigned := st.assignments[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}]
		switch {
		case it.topo == TopologyBus:
			if assigned && a.BusLineID != nil && lineSystem[*a.BusLineID] == it.system {
				id := *a.BusLineID
				m.LineID, m.Pinned = &id, true
			} else {
				if assigned && a.BusLineID != nil {
					m.Dangling = "bus_line"
				}
				if id, ok := firstLine[it.system]; ok {
					m.LineID = &id
				}
			}
		case it.topo == TopologyWireless && !it.gateway:
			if assigned && a.GatewayPlanID != nil && a.GatewayItemID != nil {
				if sys, ok := gwSystem[[2]uuid.UUID{*a.GatewayPlanID, *a.GatewayItemID}]; ok && sys == it.system {
					p, i := *a.GatewayPlanID, *a.GatewayItemID
					m.GatewayPlanID, m.GatewayItemID, m.Pinned = &p, &i, true
				} else {
					m.Dangling = "gateway"
				}
			}
			if !m.Pinned {
				if g, ok := defaultGateway(gws, it); ok {
					p, i := g.ref.PlanID, g.ref.ItemID
					m.GatewayPlanID, m.GatewayItemID = &p, &i
				}
			}
		}
		out = append(out, m)
	}
	return out
}

// defaultLinesHook creates the default line ("Line 1", D451) of every bus
// system that has members in the version but no line yet, inside the
// content save of a floorplan or board (D372). Prepare finds the bus
// systems of the saved variants; Apply checks the version's items in the
// save's transaction, so add-ons and removed items create nothing.
func (s *Service) defaultLinesHook() plans.ContentHook {
	return plans.ContentHook{
		Prepare: func(ctx context.Context, _ uuid.UUID, ids []uuid.UUID) (any, error) {
			variants, err := s.products.BOMVariants(ctx, ids)
			if err != nil {
				return nil, err
			}
			bus := map[uuid.UUID]producttypes.ProductType{}
			for id, v := range variants {
				if v.ProductType.Topology == TopologyBus {
					bus[id] = v.ProductType
				}
			}
			return bus, nil
		},
		Apply: func(ctx context.Context, tx pgx.Tx, ref projects.VersionRef, prepared any) error {
			bus, _ := prepared.(map[uuid.UUID]producttypes.ProductType)
			if len(bus) == 0 {
				return nil
			}
			q := s.q.WithTx(tx)
			if err := q.LockVersionLines(ctx, ref.ID); err != nil {
				return err
			}
			lines, err := q.ListBusLines(ctx, ref.ID)
			if err != nil {
				return err
			}
			has := map[uuid.UUID]bool{}
			for _, l := range lines {
				has[l.ProductTypeID] = true
			}
			missing := false
			for _, t := range bus {
				if !has[t.ID] {
					missing = true
				}
			}
			if !missing {
				return nil
			}
			planItems, err := s.plans.NetworkItems(ctx, tx, ref.ID)
			if err != nil {
				return err
			}
			for _, p := range planItems {
				for _, it := range p.Items {
					if it.VariantID == nil {
						continue
					}
					t, ok := bus[*it.VariantID]
					if !ok || has[t.ID] {
						continue
					}
					if _, err := q.CreateBusLine(ctx, store.CreateBusLineParams{
						TenantID: ref.TenantID, VersionID: ref.ID, ProductTypeID: t.ID, Name: defaultLineName(ref.Language),
					}); err != nil {
						return err
					}
					has[t.ID] = true
				}
			}
			return nil
		},
	}
}

// defaultLineNames are the names of a system's automatic first line per
// content language (data in the project's language, not UI text: the user
// renames it, D451). Languages without an entry use en.
var defaultLineNames = map[string]string{"en": "Line 1", "de": "Linie 1"}

// defaultLineName is the automatic first line's name in a project language.
func defaultLineName(language string) string {
	if n, ok := defaultLineNames[language]; ok {
		return n
	}
	return defaultLineNames["en"]
}

// view computes the networks from the state (members, D372).
func (st state) view(can bool) Networks {
	out := Networks{VersionID: st.ref.ID, BusSystems: []BusSystem{}, WirelessSystems: []WirelessSystem{}, Can: NetworkActions{Update: can}}
	members := st.members()
	systemType := func(id uuid.UUID) producttypes.ProductType {
		if t, ok := st.types[id]; ok {
			return t
		}
		for _, m := range members { // a type created after the catalog read
			if m.SystemID == id {
				return st.variants[m.item.ref.VariantID].ProductType
			}
		}
		return producttypes.ProductType{ID: id}
	}
	refOf := func(id uuid.UUID) SystemRef {
		t := systemType(id)
		return SystemRef{ID: id, Key: t.Key, Name: t.Name, Abbreviation: t.Abbreviation, Color: t.Color}
	}

	// Bus systems: every system with a line or a member.
	busIndex := map[uuid.UUID]int{}
	lineIndex := map[uuid.UUID][2]int{}
	addBus := func(id uuid.UUID) int {
		if i, ok := busIndex[id]; ok {
			return i
		}
		out.BusSystems = append(out.BusSystems, BusSystem{ProductType: refOf(id), Lines: []BusLineNetwork{}, Unassigned: []BusMember{}})
		busIndex[id] = len(out.BusSystems) - 1
		return busIndex[id]
	}
	for _, l := range st.lines {
		i := addBus(l.ProductTypeID)
		out.BusSystems[i].Lines = append(out.BusSystems[i].Lines, BusLineNetwork{BusLine: lineOf(l), Members: []BusMember{}})
		lineIndex[l.ID] = [2]int{i, len(out.BusSystems[i].Lines) - 1}
	}
	for _, mem := range members {
		if mem.Topology != TopologyBus {
			continue
		}
		it := mem.item
		i := addBus(it.system)
		m := BusMember{
			ItemRef: it.ref, BusCurrentUsedMa: it.caps.BusCurrentUsedMa, BusCurrentUsedMaDefault: it.caps.BusCurrentUsedMaDefault,
			BusCurrentSuppliedMa: it.caps.BusCurrentSuppliedMa,
			PowerSupply:          it.caps.BusCurrentSuppliedMa != nil && *it.caps.BusCurrentSuppliedMa > 0,
			Pinned:               mem.Pinned,
		}
		if mem.LineID == nil {
			out.BusSystems[i].Unassigned = append(out.BusSystems[i].Unassigned, m)
			continue
		}
		li := lineIndex[*mem.LineID]
		line := &out.BusSystems[li[0]].Lines[li[1]]
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
	gateways := map[[2]uuid.UUID][2]int{}
	addWireless := func(id uuid.UUID) int {
		if i, ok := wIndex[id]; ok {
			return i
		}
		out.WirelessSystems = append(out.WirelessSystems, WirelessSystem{ProductType: refOf(id), Gateways: []Gateway{}, Unassigned: []WirelessDevice{}})
		wIndex[id] = len(out.WirelessSystems) - 1
		return wIndex[id]
	}
	for _, mem := range members {
		if !mem.Gateway {
			continue
		}
		it := mem.item
		i := addWireless(it.system)
		out.WirelessSystems[i].Gateways = append(out.WirelessSystems[i].Gateways, Gateway{
			ItemRef: it.ref, WirelessPlacesSupplied: *it.caps.WirelessPlacesSupplied, Devices: []WirelessDevice{},
		})
		gateways[[2]uuid.UUID{it.ref.PlanID, it.ref.ItemID}] = [2]int{i, len(out.WirelessSystems[i].Gateways) - 1}
	}
	for _, mem := range members {
		if mem.Topology != TopologyWireless || mem.Gateway {
			continue
		}
		it := mem.item
		i := addWireless(it.system)
		d := WirelessDevice{ItemRef: it.ref, WirelessPlacesUsed: it.caps.WirelessPlacesUsed, WirelessPlacesUsedDefault: it.caps.WirelessPlacesUsedDefault, Pinned: mem.Pinned}
		if mem.GatewayPlanID == nil {
			out.WirelessSystems[i].Unassigned = append(out.WirelessSystems[i].Unassigned, d)
			continue
		}
		gi := gateways[[2]uuid.UUID{*mem.GatewayPlanID, *mem.GatewayItemID}]
		g := &out.WirelessSystems[gi[0]].Gateways[gi[1]]
		g.Devices = append(g.Devices, d)
		if d.WirelessPlacesUsed != nil {
			g.WirelessPlacesUsed += *d.WirelessPlacesUsed
		} else {
			g.UnknownPlacesCount++
		}
	}
	order := func(id uuid.UUID) int32 { return systemType(id).SortOrder }
	slices.SortStableFunc(out.BusSystems, func(a, b BusSystem) int { return int(order(a.ProductType.ID) - order(b.ProductType.ID)) })
	slices.SortStableFunc(out.WirelessSystems, func(a, b WirelessSystem) int {
		return int(order(a.ProductType.ID) - order(b.ProductType.ID))
	})
	return out
}

// defaultGateway picks a wireless device's gateway (D359): the first
// gateway of its system on the same plan, else the nearest by plan order
// (the earlier plan on a tie), which is also the first when all are equally
// far. gws are the gateways in plan and item order.
func defaultGateway(gws []item, dev item) (item, bool) {
	var best item
	found, bestDist := false, 0
	for _, g := range gws {
		if g.system != dev.system {
			continue
		}
		if g.ref.PlanID == dev.ref.PlanID {
			return g, true
		}
		d := g.planPos - dev.planPos
		if d < 0 {
			d = -d
		}
		if !found || d < bestDist || (d == bestDist && g.planPos < best.planPos) {
			best, bestDist, found = g, d, true
		}
	}
	return best, found
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
		if a.BusLineID == nil && a.GatewayPlanID == nil && a.GatewayItemID == nil {
			continue // clearing also works for an item removed meanwhile
		}
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
	if err := q.CopyAssignments(ctx, store.CopyAssignmentsParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID, PlanMap: data}); err != nil {
		return err
	}
	return copyAddresses(ctx, q, data, target.TenantID, source.ID, target.ID)
}

// ---------------------------------------------------------------- helpers

func lineOf(r store.BusLine) BusLine {
	return BusLine{
		ID: r.ID, VersionID: r.VersionID, ProductTypeID: r.ProductTypeID, Name: r.Name, Address: r.Address, Position: r.Position,
		DevicesMax: r.DevicesMax, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
}

func validateLine(name, address string, devicesMax *int32) (string, string, error) {
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
	if devicesMax != nil && (*devicesMax < 1 || *devicesMax > MaxDevicesMax) {
		errs = append(errs, apperr.Field("body.devicesMax", "bus_line.devices_max_invalid", "1-10000 or empty").With("max", MaxDevicesMax))
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

func isFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func errLineNotFound() *apperr.Error { return apperr.NotFound("bus_line.not_found") }
