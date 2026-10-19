// Package wiring connects the needs of a project version to channels of
// board modules and floorplan devices (step 3d), evaluates the version (the
// checks engine) and connects automatically. Needs, placements and modules
// are read through plans.Service, the catalog through the products,
// capabilities, function types and product types services, bus lines and
// gateways through networks.Service (D372). Connections reference needs and
// items by (plan_id, id) without foreign keys (D340, D378).
//
// The table is tenant-owned (row-level security, database.InScope).
package wiring

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring/store"
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
	db            DB
	q             *store.Queries
	projects      *projects.Service
	plans         *plans.Service
	products      *products.Service
	types         *producttypes.Service
	capabilities  *capabilities.Service
	functionTypes *functiontypes.Service
	networks      *networks.Service
}

// NewService wires the feature and registers its plan copier (connections
// follow a version copy, plan ids mapped, D339).
func NewService(db DB, projectSvc *projects.Service, planSvc *plans.Service, productSvc *products.Service, typeSvc *producttypes.Service,
	capSvc *capabilities.Service, functionTypeSvc *functiontypes.Service, networkSvc *networks.Service) *Service {
	s := &Service{db: db, q: store.New(db), projects: projectSvc, plans: planSvc, products: productSvc, types: typeSvc,
		capabilities: capSvc, functionTypes: functionTypeSvc, networks: networkSvc}
	planSvc.OnCopyPlans(s.copyPlans)
	return s
}

func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- loading

// facts are the catalog facts of a version's items, read outside any
// transaction (D243).
type facts struct {
	cat      Catalog
	variants map[uuid.UUID]products.BOMVariant
	caps     map[uuid.UUID]capabilities.Capabilities
	types    map[uuid.UUID]producttypes.ProductType
	// kinds are the active output kinds in order.
	kinds []capabilities.OutputKind
}

func variantIDs(data plans.WiringData) []uuid.UUID {
	var out []uuid.UUID
	for _, p := range data.Plans {
		for _, list := range [][]plans.WiringItem{p.Placements, p.Modules} {
			for _, it := range list {
				if it.VariantID != nil {
					out = append(out, *it.VariantID)
				}
			}
		}
	}
	slices.SortFunc(out, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	return slices.Compact(out)
}

func (s *Service) facts(ctx context.Context, ids []uuid.UUID) (facts, error) {
	f := facts{cat: Catalog{Served: map[uuid.UUID]map[uuid.UUID]bool{}, KindOrder: map[uuid.UUID]int{}, KindKey: map[uuid.UUID]string{},
		Circuit: map[uuid.UUID]bool{}, FunctionKey: map[uuid.UUID]string{}, LoadTypeKey: map[uuid.UUID]string{}},
		caps: map[uuid.UUID]capabilities.Capabilities{}, types: map[uuid.UUID]producttypes.ProductType{}}
	var err error
	if f.variants, err = s.products.BOMVariants(ctx, ids); err != nil {
		return f, err
	}
	if len(ids) > 0 {
		if f.caps, err = s.products.Capabilities(ctx, ids); err != nil {
			return f, err
		}
	}
	if f.kinds, err = s.capabilities.OutputKinds(ctx, false); err != nil {
		return f, err
	}
	for i, k := range f.kinds {
		f.cat.KindOrder[k.ID], f.cat.KindKey[k.ID] = i, k.Key
		f.cat.Served[k.ID] = map[uuid.UUID]bool{}
		for _, ft := range k.FunctionTypeIDs {
			f.cat.Served[k.ID][ft] = true
		}
	}
	fts, err := s.functionTypes.List(ctx)
	if err != nil {
		return f, err
	}
	for _, ft := range fts {
		f.cat.Circuit[ft.ID], f.cat.FunctionKey[ft.ID] = ft.AllowsCircuit, ft.Key
	}
	lts, err := s.capabilities.LoadTypes(ctx, true)
	if err != nil {
		return f, err
	}
	for _, l := range lts {
		f.cat.LoadTypeKey[l.ID] = l.Key
	}
	types, err := s.types.List(ctx, true)
	if err != nil {
		return f, err
	}
	for _, t := range types {
		f.types[t.ID] = t
	}
	return f, nil
}

// covers reports whether the facts know every variant of data (a variant
// added between the catalog read and the transaction is not).
func (f facts) covers(data plans.WiringData) bool {
	for _, id := range variantIDs(data) {
		if _, ok := f.caps[id]; !ok {
			if _, known := f.variants[id]; !known {
				return false
			}
		}
	}
	return true
}

// powerCW parses a power (decimal string with 2 places) into hundredths.
func powerCW(s *string) *int64 {
	if s == nil {
		return nil
	}
	d, err := decimal.NewFromString(*s)
	if err != nil {
		return nil
	}
	v := d.Shift(2).IntPart()
	return &v
}

// build makes the state of a version: needs, items and connections.
func build(f *facts, data plans.WiringData, conns []store.Connection) *state {
	needs := map[NeedKey]*Need{}
	items := map[ItemKey]*Item{}
	for _, p := range data.Plans {
		for _, n := range p.Needs {
			k := NeedKey{p.ID, n.ID}
			needs[k] = &Need{Key: k, ZoneID: n.ZoneID, FunctionTypeID: n.FunctionTypeID, Quantity: n.Quantity, PowerCW: powerCW(n.PowerW),
				LoadTypeID: n.LoadTypeID, Label: n.Label}
		}
		add := func(it plans.WiringItem, board bool) {
			k := ItemKey{p.ID, it.ID}
			item := &Item{Key: k, Board: board, ZoneID: it.ZoneID, Label: it.Label, Voltage: producttypes.DefaultNominalVoltage}
			if it.VariantID != nil {
				if c, ok := f.caps[*it.VariantID]; ok {
					item.HasVariant, item.Caps = true, c
				}
				if v, ok := f.variants[*it.VariantID]; ok && v.ProductType.NominalVoltage > 0 {
					item.Voltage = float64(v.ProductType.NominalVoltage)
				}
			}
			items[k] = item
		}
		for _, it := range p.Placements {
			add(it, false)
		}
		for _, it := range p.Modules {
			add(it, true)
		}
	}
	st := newState(&f.cat, needs, items)
	for _, c := range conns {
		st.add(connOf(c))
	}
	return st
}

func connOf(c store.Connection) *Conn {
	return &Conn{ID: c.ID, Need: NeedKey{c.NeedPlanID, c.NeedID}, Units: c.Units,
		Channel: ChannelKey{Item: ItemKey{c.TargetPlanID, c.TargetItemID}, Kind: c.OutputKindID, No: int(c.ChannelNo)},
		Pinned:  c.Pinned, BatchID: c.BatchID}
}

func connectionOut(c store.Connection) Connection {
	return Connection{ID: c.ID, VersionID: c.VersionID, NeedPlanID: c.NeedPlanID, NeedID: c.NeedID, Units: c.Units,
		TargetPlanID: c.TargetPlanID, TargetItemID: c.TargetItemID, OutputKindID: c.OutputKindID, ChannelNo: c.ChannelNo,
		Pinned: c.Pinned, BatchID: c.BatchID, CreatedAt: c.CreatedAt}
}

// snapshot is a version read for the checks and previews.
type snapshot struct {
	ref   projects.VersionRef
	data  plans.WiringData
	conns []store.Connection
	facts facts
	st    *state
}

// read loads a version in one snapshot, then the catalog (D243).
func (s *Service) read(ctx context.Context, actor auth.Actor, versionID uuid.UUID) (*snapshot, error) {
	sn := &snapshot{}
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if sn.ref, err = s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		if sn.data, err = s.plans.WiringData(ctx, tx, versionID); err != nil {
			return err
		}
		sn.conns, err = q.ListConnections(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if sn.facts, err = s.facts(ctx, variantIDs(sn.data)); err != nil {
		return nil, err
	}
	sn.st = build(&sn.facts, sn.data, sn.conns)
	return sn, nil
}

// write runs fn on the current state of a version under the version's
// write lock (the project row, exclusive): the catalog is read first from a
// snapshot (D243), then the version is read again in the write transaction.
// Read-only projects are refused (project.read_only).
func (s *Service) write(ctx context.Context, actor auth.Actor, versionID uuid.UUID, fn func(tx pgx.Tx, q *store.Queries, sn *snapshot) error) error {
	pre, err := s.read(ctx, actor, versionID)
	if err != nil {
		return err
	}
	if !pre.ref.Writable() {
		return apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		sn := &snapshot{facts: pre.facts}
		var err error
		if sn.ref, err = s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		if sn.data, err = s.plans.WiringData(ctx, tx, versionID); err != nil {
			return err
		}
		if !sn.facts.covers(sn.data) {
			return errChanged()
		}
		if sn.conns, err = q.ListConnections(ctx, versionID); err != nil {
			return err
		}
		sn.st = build(&sn.facts, sn.data, sn.conns)
		return fn(tx, q, sn)
	})
}

func errChanged() *apperr.Error {
	return apperr.Conflict("connection.changed", "the version was changed meanwhile; reload")
}

func errNotFound() *apperr.Error { return apperr.NotFound("connection.not_found") }

// ---------------------------------------------------------------- connections

// List returns the connections of a version.
func (s *Service) List(ctx context.Context, versionID uuid.UUID) (Connections, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Connections{}, err
	}
	var rows []store.Connection
	var ref projects.VersionRef
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if ref, err = s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListConnections(ctx, versionID)
		return err
	})
	if err != nil {
		return Connections{}, err
	}
	out := Connections{Items: make([]Connection, len(rows)), Can: ConnectionActions{Update: actor.Can(auth.PermProjectsWrite) && ref.Writable()}}
	for i, r := range rows {
		out.Items[i] = connectionOut(r)
	}
	return out, nil
}

// fieldOf is where a validity error of connect is reported.
func fieldOf(code string) string {
	switch code {
	case CodeNeedNotFound:
		return "body.needId"
	case CodeUnitsExceeded:
		return "body.units"
	case CodeTargetNotFound:
		return "body.targetItemId"
	case CodeFunctionNotServed:
		return "body.outputKindId"
	}
	return "body.channelNo"
}

// refuse turns the first error a connection takes part in into a field
// error; warnings are returned.
func refuse(st *state, c *Conn) ([]Finding, error) {
	problems := st.problemsFor(c)
	if p := firstError(problems, c.ID); p != nil {
		e := apperr.Field(fieldOf(p.Code), "connection."+p.Code, "the connection is not valid")
		for k, v := range p.Params {
			e = e.With(k, v)
		}
		return nil, apperr.Validation(e)
	}
	warnings := []Finding{}
	for _, p := range problems {
		if p.Severity == SeverityWarning && slices.Contains(p.Conns, c.ID) {
			warnings = append(warnings, findingOf(p))
		}
	}
	return warnings, nil
}

// Connect connects units of a need to a channel (pinned).
func (s *Service) Connect(ctx context.Context, versionID uuid.UUID, in ConnectionInput) (ConnectionResult, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ConnectionResult{}, err
	}
	if in.Units < 1 || in.Units > 100 {
		return ConnectionResult{}, apperr.Invalid("body.units", "validation.range", "1-100").With("min", 1).With("max", 100)
	}
	var out ConnectionResult
	err = s.write(ctx, actor, versionID, func(tx pgx.Tx, q *store.Queries, sn *snapshot) error {
		c := &Conn{ID: uuid.New(), Need: NeedKey{in.NeedPlanID, in.NeedID}, Units: in.Units, Pinned: true,
			Channel: ChannelKey{Item: ItemKey{in.TargetPlanID, in.TargetItemID}, Kind: in.OutputKindID, No: int(in.ChannelNo)}}
		sn.st.add(c)
		warnings, err := refuse(sn.st, c)
		if err != nil {
			return err
		}
		row, err := q.CreateConnection(ctx, store.CreateConnectionParams{
			TenantID: sn.ref.TenantID, VersionID: versionID, NeedPlanID: in.NeedPlanID, NeedID: in.NeedID, Units: in.Units,
			TargetPlanID: in.TargetPlanID, TargetItemID: in.TargetItemID, OutputKindID: in.OutputKindID, ChannelNo: in.ChannelNo, Pinned: true,
		})
		if err != nil {
			return mapFK(err)
		}
		out = ConnectionResult{Connection: connectionOut(row), Warnings: warnings}
		return nil
	})
	return out, err
}

// Update changes a connection's units or moves it to another channel; it
// becomes pinned and leaves its auto-connect batch.
func (s *Service) Update(ctx context.Context, versionID, id uuid.UUID, in ConnectionUpdate) (ConnectionResult, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ConnectionResult{}, err
	}
	if in.Units < 1 || in.Units > 100 {
		return ConnectionResult{}, apperr.Invalid("body.units", "validation.range", "1-100").With("min", 1).With("max", 100)
	}
	var out ConnectionResult
	err = s.write(ctx, actor, versionID, func(tx pgx.Tx, q *store.Queries, sn *snapshot) error {
		var old *Conn
		for _, c := range sn.st.conns {
			if c.ID == id {
				old = c
			}
		}
		if old == nil {
			return errNotFound()
		}
		sn.st.remove(old)
		c := &Conn{ID: id, Need: old.Need, Units: in.Units, Pinned: true,
			Channel: ChannelKey{Item: ItemKey{in.TargetPlanID, in.TargetItemID}, Kind: in.OutputKindID, No: int(in.ChannelNo)}}
		sn.st.add(c)
		warnings, err := refuse(sn.st, c)
		if err != nil {
			return err
		}
		row, err := q.UpdateConnection(ctx, store.UpdateConnectionParams{VersionID: versionID, ID: id, Units: in.Units,
			TargetPlanID: in.TargetPlanID, TargetItemID: in.TargetItemID, OutputKindID: in.OutputKindID, ChannelNo: in.ChannelNo})
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound()
		}
		if err != nil {
			return mapFK(err)
		}
		out = ConnectionResult{Connection: connectionOut(row), Warnings: warnings}
		return nil
	})
	return out, err
}

// Delete removes a connection.
func (s *Service) Delete(ctx context.Context, versionID, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		n, err := q.DeleteConnection(ctx, store.DeleteConnectionParams{VersionID: versionID, ID: id})
		if err != nil {
			return err
		}
		if n == 0 {
			return errNotFound()
		}
		return nil
	})
}

// Disconnect removes every connection of a need or of a channel.
func (s *Service) Disconnect(ctx context.Context, versionID uuid.UUID, in DisconnectInput) (Removed, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Removed{}, err
	}
	need := in.NeedPlanID != nil && in.NeedID != nil
	channel := in.TargetPlanID != nil && in.TargetItemID != nil && in.OutputKindID != nil && in.ChannelNo != nil
	if need == channel {
		return Removed{}, apperr.Invalid("body", "connection.disconnect_target", "give a need (needPlanId, needId) or a channel (targetPlanId, targetItemId, outputKindId, channelNo)")
	}
	var n int64
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		if need {
			n, err = q.DeleteNeedConnections(ctx, store.DeleteNeedConnectionsParams{VersionID: versionID, NeedPlanID: *in.NeedPlanID, NeedID: *in.NeedID})
			return err
		}
		n, err = q.DeleteChannelConnections(ctx, store.DeleteChannelConnectionsParams{VersionID: versionID, TargetPlanID: *in.TargetPlanID,
			TargetItemID: *in.TargetItemID, OutputKindID: *in.OutputKindID, ChannelNo: *in.ChannelNo})
		return err
	})
	return Removed{Removed: n}, err
}

// mapFK: a plan deleted between the read and the insert.
func mapFK(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return errChanged()
	}
	return err
}

// ---------------------------------------------------------------- copy

// copyPlans copies the connections of a version copy, plan ids mapped
// (plans.Service.OnCopyPlans); batches stay with the source.
func (s *Service) copyPlans(ctx context.Context, tx pgx.Tx, planIDs map[uuid.UUID]uuid.UUID, source, target projects.VersionRef) error {
	if _, err := auth.Require(ctx, auth.PermProjectsWrite); err != nil {
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
	return s.q.WithTx(tx).CopyConnections(ctx, store.CopyConnectionsParams{TenantID: target.TenantID, TargetID: target.ID, SourceID: source.ID, PlanMap: data})
}
