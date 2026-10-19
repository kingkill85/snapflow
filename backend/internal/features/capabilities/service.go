// Package capabilities manages the catalog configuration behind product
// capabilities (step 3a, D187-D191): load types, output kinds (with the
// function types they serve and an optional alternative), and the
// catalog-wide field registry whose meanings turn attribute values into
// capabilities (Compute). Reads need catalog.read, writes catalog.write.
package capabilities

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Limits.
const (
	MaxKeyLength   = 64
	MaxNameLength  = 100
	MaxEtimLength  = 20
	maxAlternative = 16
)

// Advisory lock keys (unique in the app) serialising sort orders.
const (
	loadTypeOrderLock   int64 = 0x5f_6c_74_6f_72_64       // "_ltord"
	outputKindOrderLock int64 = 0x5f_6f_6b_6f_72_64       // "_okord"
	fieldOrderLock      int64 = 0x5f_63_66_6f_72_64_00_01 // "_cford"
)

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// FieldUsage returns the categories that link each catalog field key, read
// in tx (nil: outside a transaction). Wired to categories.Service.FieldUsers;
// capabilities does not read categories (D305).
type FieldUsage func(ctx context.Context, tx pgx.Tx) (map[string][]FieldUser, error)

type Service struct {
	db          DB
	q           *store.Queries
	usage       FieldUsage
	profileRefs ProfileRefs
}

// ProfileRefs counts the import profiles whose mapping links a catalog field
// key (wired to imports.Service.ProfilesLinkingField).
type ProfileRefs func(ctx context.Context, tx pgx.Tx, key string) (int, error)

// OnProfileRefs sets the lookup of import profiles linking a field key.
func (s *Service) OnProfileRefs(fn ProfileRefs) { s.profileRefs = fn }

func NewService(db DB) *Service {
	return &Service{db: db, q: store.New(db)}
}

// OnFieldUsage sets the lookup of the categories linking each field (a
// linked field's key and type cannot change, and it cannot be deleted).
func (s *Service) OnFieldUsage(fn FieldUsage) { s.usage = fn }

// WithTx returns the service working inside tx (see database.Nested).
func (s *Service) WithTx(tx pgx.Tx) *Service {
	out := NewService(database.NewNested(tx))
	out.usage, out.profileRefs = s.usage, s.profileRefs
	return out
}

func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- load types

// LoadTypes lists the load types in order; inactive ones only with includeInactive.
func (s *Service) LoadTypes(ctx context.Context, includeInactive bool) ([]LoadType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListLoadTypes(ctx, includeInactive)
	if err != nil {
		return nil, err
	}
	out := make([]LoadType, len(rows))
	for i, r := range rows {
		out[i] = loadTypeOut(actor, r)
	}
	return out, nil
}

func (s *Service) LoadType(ctx context.Context, id uuid.UUID) (LoadType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return LoadType{}, err
	}
	row, err := s.q.GetLoadType(ctx, id)
	if err != nil {
		return LoadType{}, mapErr(err, "load_type", "")
	}
	return loadTypeOut(actor, row), nil
}

func (s *Service) CreateLoadType(ctx context.Context, in LoadTypeInput) (LoadType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return LoadType{}, err
	}
	if in, err = validateLoadType(in); err != nil {
		return LoadType{}, err
	}
	var row store.LoadType
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockOrder(ctx, loadTypeOrderLock); err != nil {
			return err
		}
		row, err = q.CreateLoadType(ctx, store.CreateLoadTypeParams{Key: in.Key, Name: in.Name, IsActive: in.IsActive,
			PowerFactor: powerFactorText(in.PowerFactor, "1.00")})
		return err
	})
	if err != nil {
		return LoadType{}, mapErr(err, "load_type", in.Key)
	}
	return loadTypeOut(actor, row), nil
}

func (s *Service) UpdateLoadType(ctx context.Context, id uuid.UUID, in LoadTypeUpdate) (LoadType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return LoadType{}, err
	}
	if in.LoadTypeInput, err = validateLoadType(in.LoadTypeInput); err != nil {
		return LoadType{}, err
	}
	var row store.LoadType
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateLoadType(ctx, store.UpdateLoadTypeParams{ID: id, Key: in.Key, Name: in.Name, IsActive: in.IsActive,
			PowerFactor: pfOrNil(in.PowerFactor), ExpectedUpdatedAt: in.ExpectedUpdatedAt})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return LoadType{}, s.goneOrStale(ctx, "load_type", s.q.LoadTypeExists, id)
	}
	if err != nil {
		return LoadType{}, mapErr(err, "load_type", in.Key)
	}
	return loadTypeOut(actor, row), nil
}

// DeleteLoadType removes a load type no function type or field uses
// (load_type.in_use otherwise).
func (s *Service) DeleteLoadType(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.deleteRow(ctx, "load_type", func(q *store.Queries) (int64, error) { return q.DeleteLoadType(ctx, id) })
}

func (s *Service) ReorderLoadTypes(ctx context.Context, ids []uuid.UUID) ([]LoadType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	err := s.reorder(ctx, "load_type", loadTypeOrderLock, ids,
		func(q *store.Queries) ([]uuid.UUID, error) { return q.LockLoadTypeIDs(ctx) },
		func(q *store.Queries) error { return q.SetLoadTypeOrder(ctx, ids) })
	if err != nil {
		return nil, err
	}
	return s.LoadTypes(ctx, true)
}

func validateLoadType(in LoadTypeInput) (LoadTypeInput, error) {
	var errs []apperr.FieldError
	errs = append(errs, checkKey(in.Key, "load_type")...)
	in.Name, errs = checkName(in.Name, "body.name", errs)
	if in.PowerFactor != nil {
		pf := math.Round(*in.PowerFactor*100) / 100
		if pf < 0.1 || pf > 1 || math.IsNaN(pf) {
			errs = append(errs, apperr.Field("body.powerFactor", "validation.range", "0.10-1.00").With("min", 0.1).With("max", 1))
		}
		in.PowerFactor = &pf
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// powerFactorText is a power factor as the numeric column takes it.
func powerFactorText(pf *float64, fallback string) string {
	if pf == nil {
		return fallback
	}
	return strconv.FormatFloat(*pf, 'f', 2, 64)
}

func pfOrNil(pf *float64) *string {
	if pf == nil {
		return nil
	}
	v := powerFactorText(pf, "")
	return &v
}

func loadTypeOut(actor auth.Actor, r store.LoadType) LoadType {
	write := actor.Can(auth.PermCatalogWrite)
	pf, err := strconv.ParseFloat(r.PowerFactor, 64)
	if err != nil {
		pf = 1
	}
	return LoadType{ID: r.ID, Key: r.Key, Name: r.Name, PowerFactor: pf, SortOrder: r.SortOrder, IsActive: r.IsActive,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Can: auth.Actions{Update: write, Delete: write}}
}

// ---------------------------------------------------------------- output kinds

// OutputKinds lists the output kinds in order; inactive ones only with includeInactive.
func (s *Service) OutputKinds(ctx context.Context, includeInactive bool) ([]OutputKind, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	var out []OutputKind
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		var err error
		out, err = readOutputKinds(ctx, s.q.WithTx(tx), actor, includeInactive)
		return err
	})
	return out, err
}

func readOutputKinds(ctx context.Context, q *store.Queries, actor auth.Actor, includeInactive bool) ([]OutputKind, error) {
	rows, err := q.ListOutputKinds(ctx, includeInactive)
	if err != nil {
		return nil, err
	}
	links, err := q.ListOutputKindFunctionTypes(ctx)
	if err != nil {
		return nil, err
	}
	alts, err := q.ListOutputKindAlternatives(ctx)
	if err != nil {
		return nil, err
	}
	served := servedBy(links)
	alternatives := map[uuid.UUID][]OutputKindAlternative{}
	for _, a := range alts {
		alternatives[a.OutputKindID] = append(alternatives[a.OutputKindID], OutputKindAlternative{OutputKindID: a.FromKindID, Count: a.Count})
	}
	out := make([]OutputKind, len(rows))
	for i, r := range rows {
		out[i] = outputKindOut(actor, r, served[r.ID], alternatives[r.ID])
	}
	return out, nil
}

func (s *Service) OutputKind(ctx context.Context, id uuid.UUID) (OutputKind, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return OutputKind{}, err
	}
	all, err := s.OutputKinds(ctx, true)
	if err != nil {
		return OutputKind{}, err
	}
	for _, k := range all {
		if k.ID == id {
			return k, nil
		}
	}
	return OutputKind{}, apperr.NotFound("output_kind.not_found")
}

func (s *Service) CreateOutputKind(ctx context.Context, in OutputKindInput) (OutputKind, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return OutputKind{}, err
	}
	in, err := validateOutputKind(in)
	if err != nil {
		return OutputKind{}, err
	}
	var id uuid.UUID
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockOrder(ctx, outputKindOrderLock); err != nil {
			return err
		}
		row, err := q.CreateOutputKind(ctx, store.CreateOutputKindParams{Key: in.Key, Name: in.Name, IsActive: in.IsActive})
		if err != nil {
			return err
		}
		id = row.ID
		if err := setAlternatives(ctx, q, id, in.Alternatives); err != nil {
			return err
		}
		return setServed(ctx, q, id, in.FunctionTypeIDs)
	})
	if err != nil {
		return OutputKind{}, mapErr(err, "output_kind", in.Key)
	}
	return s.OutputKind(ctx, id)
}

func (s *Service) UpdateOutputKind(ctx context.Context, id uuid.UUID, in OutputKindUpdate) (OutputKind, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return OutputKind{}, err
	}
	var err error
	if in.OutputKindInput, err = validateOutputKind(in.OutputKindInput); err != nil {
		return OutputKind{}, err
	}
	err = s.inTx(ctx, func(q *store.Queries) error {
		// Under the order lock, so two kinds cannot become each other's
		// alternative concurrently.
		if err := q.LockOrder(ctx, outputKindOrderLock); err != nil {
			return err
		}
		if _, err := q.UpdateOutputKind(ctx, store.UpdateOutputKindParams{ID: id, Key: in.Key, Name: in.Name, IsActive: in.IsActive,
			ExpectedUpdatedAt: in.ExpectedUpdatedAt}); err != nil {
			return err
		}
		if err := q.DeleteOutputKindAlternatives(ctx, id); err != nil {
			return err
		}
		if err := setAlternatives(ctx, q, id, in.Alternatives); err != nil {
			return err
		}
		if err := q.DeleteOutputKindFunctionTypes(ctx, id); err != nil {
			return err
		}
		return setServed(ctx, q, id, in.FunctionTypeIDs)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return OutputKind{}, s.goneOrStale(ctx, "output_kind", s.q.OutputKindExists, id)
	}
	if err != nil {
		return OutputKind{}, mapErr(err, "output_kind", in.Key)
	}
	return s.OutputKind(ctx, id)
}

// DeleteOutputKind removes an output kind no field or other kind uses
// (output_kind.in_use otherwise).
func (s *Service) DeleteOutputKind(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.deleteRow(ctx, "output_kind", func(q *store.Queries) (int64, error) { return q.DeleteOutputKind(ctx, id) })
}

func (s *Service) ReorderOutputKinds(ctx context.Context, ids []uuid.UUID) ([]OutputKind, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	err := s.reorder(ctx, "output_kind", outputKindOrderLock, ids,
		func(q *store.Queries) ([]uuid.UUID, error) { return q.LockOutputKindIDs(ctx) },
		func(q *store.Queries) error { return q.SetOutputKindOrder(ctx, ids) })
	if err != nil {
		return nil, err
	}
	return s.OutputKinds(ctx, true)
}

func validateOutputKind(in OutputKindInput) (OutputKindInput, error) {
	var errs []apperr.FieldError
	errs = append(errs, checkKey(in.Key, "output_kind")...)
	in.Name, errs = checkName(in.Name, "body.name", errs)
	seen := map[uuid.UUID]bool{}
	for i, id := range in.FunctionTypeIDs {
		if seen[id] {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.functionTypeIds[%d]", i), "output_kind.function_type_duplicate", "listed twice"))
		}
		seen[id] = true
	}
	from := map[uuid.UUID]bool{}
	for i, a := range in.Alternatives {
		if a.Count < 1 || a.Count > maxAlternative {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.alternatives[%d].count", i), "validation.range", "out of range").
				With("min", 1).With("max", maxAlternative))
		}
		if from[a.OutputKindID] {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.alternatives[%d].outputKindId", i), "output_kind.alternative_duplicate", "listed twice"))
		}
		from[a.OutputKindID] = true
	}
	if in.FunctionTypeIDs == nil {
		in.FunctionTypeIDs = []uuid.UUID{}
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// setAlternatives stores a kind's alternatives (under the order lock, so two
// kinds cannot become each other's alternative concurrently). It refuses an
// unknown kind, the kind itself and a kind that has this one as its
// alternative (a cycle of two; longer cycles are harmless: alternatives are
// not followed transitively).
func setAlternatives(ctx context.Context, q *store.Queries, self uuid.UUID, alts []OutputKindAlternative) error {
	var errs []apperr.FieldError
	for i, a := range alts {
		loc := fmt.Sprintf("body.alternatives[%d].outputKindId", i)
		if a.OutputKindID == self {
			errs = append(errs, apperr.Field(loc, "output_kind.alternative_self", "a kind cannot be its own alternative"))
			continue
		}
		exists, err := q.OutputKindExists(ctx, a.OutputKindID)
		if err != nil {
			return err
		}
		if !exists {
			errs = append(errs, apperr.Field(loc, "output_kind.not_found", "no such output kind"))
			continue
		}
		cycle, err := q.AlternativeCycle(ctx, store.AlternativeCycleParams{FromKindID: a.OutputKindID, KindID: self})
		if err != nil {
			return err
		}
		if cycle {
			errs = append(errs, apperr.Field(loc, "output_kind.alternative_cycle", "that kind has this kind as its alternative"))
		}
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	for _, a := range alts {
		if err := q.InsertOutputKindAlternative(ctx, store.InsertOutputKindAlternativeParams{OutputKindID: self, FromKindID: a.OutputKindID, Count: a.Count}); err != nil {
			return err
		}
	}
	return nil
}

func setServed(ctx context.Context, q *store.Queries, id uuid.UUID, functionTypeIDs []uuid.UUID) error {
	if len(functionTypeIDs) == 0 {
		return nil
	}
	err := q.InsertOutputKindFunctionTypes(ctx, store.InsertOutputKindFunctionTypesParams{OutputKindID: id, FunctionTypeIds: functionTypeIDs})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return apperr.Validation(apperr.Field("body.functionTypeIds", "function_type.not_found", "a function type does not exist"))
	}
	return err
}

func servedBy(links []store.OutputKindFunctionType) map[uuid.UUID][]uuid.UUID {
	out := map[uuid.UUID][]uuid.UUID{}
	for _, l := range links {
		out[l.OutputKindID] = append(out[l.OutputKindID], l.FunctionTypeID)
	}
	return out
}

func outputKindOut(actor auth.Actor, r store.OutputKind, served []uuid.UUID, alts []OutputKindAlternative) OutputKind {
	write := actor.Can(auth.PermCatalogWrite)
	k := OutputKind{ID: r.ID, Key: r.Key, Name: r.Name, SortOrder: r.SortOrder, IsActive: r.IsActive,
		FunctionTypeIDs: served, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Can: auth.Actions{Update: write, Delete: write}}
	if k.FunctionTypeIDs == nil {
		k.FunctionTypeIDs = []uuid.UUID{}
	}
	k.Alternatives = alts
	if k.Alternatives == nil {
		k.Alternatives = []OutputKindAlternative{}
	}
	return k
}

// ---------------------------------------------------------------- catalog fields

// Fields lists the catalog fields in order.
func (s *Service) Fields(ctx context.Context) ([]CatalogField, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	var out []CatalogField
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		var err error
		if out, err = readFields(ctx, s.q.WithTx(tx), actor); err != nil {
			return err
		}
		if s.usage == nil {
			return nil
		}
		users, err := s.usage(ctx, tx)
		if err != nil {
			return err
		}
		for i := range out {
			out[i].UsedBy = append(out[i].UsedBy, users[out[i].Key]...)
			out[i].InUse = len(out[i].UsedBy)
		}
		return nil
	})
	return out, err
}

func readFields(ctx context.Context, q *store.Queries, actor auth.Actor) ([]CatalogField, error) {
	rows, err := q.ListCatalogFields(ctx)
	if err != nil {
		return nil, err
	}
	links, err := q.ListCatalogFieldProductTypes(ctx)
	if err != nil {
		return nil, err
	}
	limited := map[uuid.UUID][]uuid.UUID{}
	for _, l := range links {
		limited[l.CatalogFieldID] = append(limited[l.CatalogFieldID], l.ProductTypeID)
	}
	out := make([]CatalogField, len(rows))
	for i, r := range rows {
		if out[i], err = fieldOut(actor, r, limited[r.ID]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// LockFields locks the catalog fields with the given keys against key and
// type changes until the caller's transaction ends (the categories service
// calls it, through WithTx, before it validates and stores links; D305) and
// returns them by key. Unknown keys are left out.
func (s *Service) LockFields(ctx context.Context, keys []string) (map[string]CatalogField, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ShareCatalogFields(ctx, keys)
	if err != nil {
		return nil, err
	}
	out := make(map[string]CatalogField, len(rows))
	for _, r := range rows {
		f, err := fieldOut(actor, r, nil)
		if err != nil {
			return nil, err
		}
		out[f.Key] = f
	}
	return out, nil
}

// FieldsByKey returns the catalog fields by key (without inUse / usedBy).
func (s *Service) FieldsByKey(ctx context.Context) (map[string]CatalogField, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	var list []CatalogField
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		var err error
		list, err = readFields(ctx, s.q.WithTx(tx), actor)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := make(map[string]CatalogField, len(list))
	for _, f := range list {
		out[f.Key] = f
	}
	return out, nil
}

func (s *Service) Field(ctx context.Context, id uuid.UUID) (CatalogField, error) {
	list, err := s.Fields(ctx)
	if err != nil {
		return CatalogField{}, err
	}
	for _, f := range list {
		if f.ID == id {
			return f, nil
		}
	}
	return CatalogField{}, apperr.NotFound("catalog_field.not_found")
}

// CreateField adds a catalog field at the end of the order.
func (s *Service) CreateField(ctx context.Context, in CatalogFieldInput) (CatalogField, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogField{}, err
	}
	var id uuid.UUID
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		id, err = s.createField(ctx, q, in, "body")
		return err
	})
	if err != nil {
		return CatalogField{}, err
	}
	return s.Field(ctx, id)
}

// CreateFields adds several catalog fields in one transaction (the import's
// answers); errors are reported at loc(i).
func (s *Service) CreateFields(ctx context.Context, in []CatalogFieldInput, loc func(i int) string) ([]CatalogField, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(in))
	err := s.inTx(ctx, func(q *store.Queries) error {
		existing, err := q.ListCatalogFields(ctx)
		if err != nil {
			return err
		}
		taken := map[string]bool{}
		for _, f := range existing {
			taken[f.Key] = true
		}
		var all []apperr.FieldError
		valid := make([]CatalogFieldInput, len(in))
		options := make([][]byte, len(in))
		for i, f := range in {
			v, opts, err := s.validateField(ctx, q, f, loc(i))
			var ae *apperr.Error
			invalid := errors.As(err, &ae) && len(ae.Fields) > 0
			if err != nil && !invalid {
				return err
			}
			if invalid {
				all = append(all, ae.Fields...)
			}
			if taken[v.Key] {
				all = append(all, apperr.Field(loc(i)+".key", "catalog_field.key_taken", "key already exists").With("key", v.Key))
			}
			taken[v.Key] = true
			valid[i], options[i] = v, opts
		}
		if len(all) > 0 {
			return apperr.Validation(all...)
		}
		for i := range valid {
			if ids[i], err = insertField(ctx, q, valid[i], options[i], loc(i)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	byID := map[uuid.UUID]CatalogField{}
	list, err := s.Fields(ctx)
	if err != nil {
		return nil, err
	}
	for _, f := range list {
		byID[f.ID] = f
	}
	out := make([]CatalogField, len(ids))
	for i, id := range ids {
		out[i] = byID[id]
	}
	return out, nil
}

func (s *Service) createField(ctx context.Context, q *store.Queries, in CatalogFieldInput, loc string) (uuid.UUID, error) {
	in, options, err := s.validateField(ctx, q, in, loc)
	if err != nil {
		return uuid.Nil, err
	}
	return insertField(ctx, q, in, options, loc)
}

func insertField(ctx context.Context, q *store.Queries, in CatalogFieldInput, options []byte, loc string) (uuid.UUID, error) {
	if err := q.LockOrder(ctx, fieldOrderLock); err != nil {
		return uuid.Nil, err
	}
	row, err := q.CreateCatalogField(ctx, store.CreateCatalogFieldParams{
		Key: in.Key, Label: in.Label, ValueType: string(in.Type), Unit: strPtr(in.Unit), Options: options,
		EtimFeature: strPtr(in.EtimFeature), Meaning: strPtr(string(in.Meaning)), OutputKindID: in.OutputKindID, LoadTypeID: in.LoadTypeID,
	})
	if err != nil {
		return uuid.Nil, fieldErr(err, in.Key, loc)
	}
	if len(in.ProductTypeIDs) > 0 {
		if err := setProductTypes(ctx, q, row.ID, in.ProductTypeIDs, loc); err != nil {
			return uuid.Nil, err
		}
	}
	return row.ID, nil
}

// UpdateField replaces a catalog field. A field a category links keeps its
// key and type (catalog_field.in_use: checked under a row lock that category
// saves wait for, and the key by a foreign key, D305); label, unit, options
// and meaning may change and apply at once (categories resolve linked
// attributes from the field when read, D308).
func (s *Service) UpdateField(ctx context.Context, id uuid.UUID, in CatalogFieldUpdate) (CatalogField, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return CatalogField{}, err
	}
	err := database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		current, err := q.LockCatalogField(ctx, id)
		if err != nil {
			return err
		}
		if current.Key != in.Key || current.ValueType != string(in.Type) {
			if err := s.checkUnused(ctx, tx, current.Key, "categories link this field: its key and type cannot change"); err != nil {
				return err
			}
			if current.Key != in.Key {
				if err := s.checkKeyUnreferenced(ctx, tx, current.Key); err != nil {
					return err
				}
			}
		}
		var options []byte
		if in.CatalogFieldInput, options, err = s.validateField(ctx, q, in.CatalogFieldInput, "body"); err != nil {
			return err
		}
		if _, err := q.UpdateCatalogField(ctx, store.UpdateCatalogFieldParams{
			ID: id, Key: in.Key, Label: in.Label, ValueType: string(in.Type), Unit: strPtr(in.Unit), Options: options,
			EtimFeature: strPtr(in.EtimFeature), Meaning: strPtr(string(in.Meaning)), OutputKindID: in.OutputKindID,
			LoadTypeID: in.LoadTypeID, ExpectedUpdatedAt: in.ExpectedUpdatedAt,
		}); err != nil {
			return err
		}
		if err := q.DeleteCatalogFieldProductTypes(ctx, id); err != nil {
			return err
		}
		if len(in.ProductTypeIDs) == 0 {
			return nil
		}
		return setProductTypes(ctx, q, id, in.ProductTypeIDs, "body")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CatalogField{}, s.goneOrStale(ctx, "catalog_field", s.q.CatalogFieldExists, id)
	}
	if err != nil {
		return CatalogField{}, fieldErr(err, in.Key, "body")
	}
	return s.Field(ctx, id)
}

// DeleteField removes a catalog field no category links (catalog_field.in_use,
// from the foreign key of category_field_links).
func (s *Service) DeleteField(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.deleteRow(ctx, "catalog_field", func(q *store.Queries) (int64, error) { return q.DeleteCatalogField(ctx, id) })
}

func (s *Service) ReorderFields(ctx context.Context, ids []uuid.UUID) ([]CatalogField, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	err := s.reorder(ctx, "catalog_field", fieldOrderLock, ids,
		func(q *store.Queries) ([]uuid.UUID, error) { return q.LockCatalogFieldIDs(ctx) },
		func(q *store.Queries) error { return q.SetCatalogFieldOrder(ctx, ids) })
	if err != nil {
		return nil, err
	}
	return s.Fields(ctx)
}

// checkUnused fails with catalog_field.in_use when a category links key
// (read in tx, after the field row is locked: a category save that linked it
// first has committed, one that comes later waits and sees the change).
func (s *Service) checkUnused(ctx context.Context, tx pgx.Tx, key, msg string) error {
	if s.usage == nil {
		return nil
	}
	users, err := s.usage(ctx, tx)
	if err != nil {
		return err
	}
	if n := len(users[key]); n > 0 {
		return apperr.Conflict("catalog_field.in_use", msg).With("key", key).With("count", n)
	}
	return nil
}

// checkKeyUnreferenced refuses a key change while an import profile links
// the key (catalog_field.key_referenced, D309): the profile would lose its
// link silently.
func (s *Service) checkKeyUnreferenced(ctx context.Context, tx pgx.Tx, key string) error {
	if s.profileRefs == nil {
		return nil
	}
	n, err := s.profileRefs(ctx, tx, key)
	if err != nil {
		return err
	}
	if n > 0 {
		return apperr.Conflict("catalog_field.key_referenced", "import profiles link this field: its key cannot change").
			With("key", key).With("count", n)
	}
	return nil
}

// validateField checks a field (loc is its location, "body" for the field
// endpoints) and returns it normalised with its options as JSON.
func (s *Service) validateField(ctx context.Context, q *store.Queries, in CatalogFieldInput, loc string) (CatalogFieldInput, []byte, error) {
	var errs []apperr.FieldError
	for _, e := range checkKey(in.Key, "catalog_field") {
		e.Location = loc + ".key"
		errs = append(errs, e)
	}
	// The value type, unit, label and options are checked as an attribute
	// definition (one implementation, attrschema).
	switch in.Type {
	case attrschema.TypeText, attrschema.TypeNumber, attrschema.TypeInteger, attrschema.TypeBoolean, attrschema.TypeEnum:
	default:
		errs = append(errs, apperr.Field(loc+".type", "validation.invalid", "type must be text, number, integer, boolean or enum"))
	}
	def := attrschema.Definition{Key: "field", Label: in.Label, Type: in.Type, Unit: in.Unit, Options: in.Options}
	schema, schemaErrs := attrschema.CheckSchema(attrschema.Schema{{Definition: def}}, "x")
	for _, e := range schemaErrs {
		e.Location = loc + strings.TrimPrefix(e.Location, "x[0]")
		if strings.HasSuffix(e.Location, ".type") {
			continue // reported above
		}
		errs = append(errs, e)
	}
	if len(schema) == 1 {
		in.Label, in.Unit, in.Options = schema[0].Label, schema[0].Unit, schema[0].Options
	}
	if in.Options == nil {
		in.Options = []attrschema.AttributeOption{}
	}
	in.EtimFeature = strings.ToUpper(strings.TrimSpace(in.EtimFeature))
	if utf8.RuneCountInString(in.EtimFeature) > MaxEtimLength {
		errs = append(errs, apperr.Field(loc+".etimFeature", "validation.too_long", "too long").With("max", MaxEtimLength))
	}
	errs = append(errs, s.checkMeaning(ctx, q, &in, loc)...)
	seen := map[uuid.UUID]bool{}
	for i, id := range in.ProductTypeIDs {
		l := fmt.Sprintf("%s.productTypeIds[%d]", loc, i)
		if seen[id] {
			errs = append(errs, apperr.Field(l, "catalog_field.product_type_duplicate", "listed twice"))
			continue
		}
		seen[id] = true
	}
	if len(errs) > 0 {
		return in, nil, apperr.Validation(errs...)
	}
	options, err := json.Marshal(in.Options)
	return in, options, err
}

// checkMeaning checks the meaning, its parameters and that the value type
// fits it.
func (s *Service) checkMeaning(ctx context.Context, q *store.Queries, in *CatalogFieldInput, loc string) []apperr.FieldError {
	var errs []apperr.FieldError
	if in.Meaning == MeaningNone {
		if in.OutputKindID != nil {
			errs = append(errs, apperr.Field(loc+".outputKindId", "catalog_field.param_not_allowed", "this meaning has no output kind"))
		}
		if in.LoadTypeID != nil {
			errs = append(errs, apperr.Field(loc+".loadTypeId", "catalog_field.param_not_allowed", "this meaning has no load type"))
		}
		if len(in.ProductTypeIDs) > 0 {
			errs = append(errs, apperr.Field(loc+".productTypeIds", "catalog_field.param_not_allowed", "information is not limited to product types"))
		}
		return errs
	}
	spec, ok := meaningSpec(in.Meaning)
	if !ok {
		return append(errs, apperr.Field(loc+".meaning", "validation.invalid", "unknown meaning"))
	}
	if !slices.Contains(spec.Types, in.Type) {
		types := make([]string, len(spec.Types))
		for i, t := range spec.Types {
			types[i] = string(t)
		}
		errs = append(errs, apperr.Field(loc+".type", "catalog_field.meaning_type", "the meaning needs another value type").
			With("expected", strings.Join(types, ", ")))
	} else if len(spec.Options) > 0 {
		// The option keys must be exactly the ones the meaning reads
		// (motor_type: ac, dc; D310).
		keys := make([]string, len(in.Options))
		for i, o := range in.Options {
			keys[i] = o.Key
		}
		want := slices.Clone(spec.Options)
		slices.Sort(keys)
		slices.Sort(want)
		if !slices.Equal(keys, want) {
			errs = append(errs, apperr.Field(loc+".options", "catalog_field.meaning_options", "the meaning needs exactly these choices").
				With("expected", strings.Join(spec.Options, ", ")))
		}
	}
	switch {
	case spec.OutputKind && in.OutputKindID == nil:
		errs = append(errs, apperr.Field(loc+".outputKindId", "validation.required", "choose an output kind"))
	case !spec.OutputKind && in.OutputKindID != nil:
		errs = append(errs, apperr.Field(loc+".outputKindId", "catalog_field.param_not_allowed", "this meaning has no output kind"))
	case in.OutputKindID != nil:
		if exists, err := q.OutputKindExists(ctx, *in.OutputKindID); err != nil || !exists {
			errs = append(errs, apperr.Field(loc+".outputKindId", "output_kind.not_found", "no such output kind"))
		}
	}
	switch {
	case spec.LoadTypeRequired && in.LoadTypeID == nil:
		errs = append(errs, apperr.Field(loc+".loadTypeId", "validation.required", "choose a load type"))
	case !spec.LoadType && in.LoadTypeID != nil:
		errs = append(errs, apperr.Field(loc+".loadTypeId", "catalog_field.param_not_allowed", "this meaning has no load type"))
	case in.LoadTypeID != nil:
		if exists, err := q.LoadTypeExists(ctx, *in.LoadTypeID); err != nil || !exists {
			errs = append(errs, apperr.Field(loc+".loadTypeId", "load_type.not_found", "no such load type"))
		}
	}
	return errs
}

// setProductTypes limits a field to product types; an unknown one is
// product_type.not_found at loc.productTypeIds (from the foreign key: the
// service reads no product types inside its transaction, D243).
func setProductTypes(ctx context.Context, q *store.Queries, id uuid.UUID, ids []uuid.UUID, loc string) error {
	err := q.InsertCatalogFieldProductTypes(ctx, store.InsertCatalogFieldProductTypesParams{CatalogFieldID: id, ProductTypeIds: ids})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return apperr.Validation(apperr.Field(loc+".productTypeIds", "product_type.not_found", "a product type does not exist"))
	}
	return err
}

func fieldOut(actor auth.Actor, r store.CatalogField, productTypes []uuid.UUID) (CatalogField, error) {
	write := actor.Can(auth.PermCatalogWrite)
	f := CatalogField{ID: r.ID, Key: r.Key, Label: r.Label, Type: attrschema.Type(r.ValueType), Unit: deref(r.Unit),
		EtimFeature: deref(r.EtimFeature), Meaning: Meaning(deref(r.Meaning)), OutputKindID: r.OutputKindID, LoadTypeID: r.LoadTypeID,
		ProductTypeIDs: productTypes, SortOrder: r.SortOrder, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: write, Delete: write}}
	if err := json.Unmarshal(r.Options, &f.Options); err != nil {
		return f, err
	}
	if f.Options == nil {
		f.Options = []attrschema.AttributeOption{}
	}
	if f.ProductTypeIDs == nil {
		f.ProductTypeIDs = []uuid.UUID{}
	}
	return f, nil
}

// ---------------------------------------------------------------- shared

func checkKey(key, entity string) []apperr.FieldError {
	if len(key) > MaxKeyLength || !keyPattern.MatchString(key) {
		return []apperr.FieldError{apperr.Field("body.key", entity+".key_format", "key must be lower snake case, 1-64 characters")}
	}
	return nil
}

func checkName(name i18n.Text, loc string, errs []apperr.FieldError) (i18n.Text, []apperr.FieldError) {
	name = name.Trimmed()
	errs = append(errs, name.Check(loc, MaxNameLength)...)
	if !name.Valid() {
		errs = append(errs, apperr.Field(loc+".en", "validation.required", "English name is required"))
	}
	return name, errs
}

func (s *Service) goneOrStale(ctx context.Context, entity string, exists func(context.Context, uuid.UUID) (bool, error), id uuid.UUID) error {
	ok, err := exists(ctx, id)
	if err != nil {
		return err
	}
	if ok {
		return apperr.Conflict(entity+".stale", "changed by someone else")
	}
	return apperr.NotFound(entity + ".not_found")
}

func (s *Service) deleteRow(ctx context.Context, entity string, del func(q *store.Queries) (int64, error)) error {
	var n int64
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		n, err = del(q)
		return err
	})
	if err != nil {
		return mapErr(err, entity, "")
	}
	if n == 0 {
		return apperr.NotFound(entity + ".not_found")
	}
	return nil
}

func (s *Service) reorder(ctx context.Context, entity string, lock int64, ids []uuid.UUID,
	lockIDs func(q *store.Queries) ([]uuid.UUID, error), set func(q *store.Queries) error) error {
	return s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockOrder(ctx, lock); err != nil {
			return err
		}
		existing, err := lockIDs(q)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, entity+".order_mismatch", "ids must list every entry exactly once")
		}
		return set(q)
	})
}

func sameSet(ids, existing []uuid.UUID) bool {
	if len(ids) != len(existing) {
		return false
	}
	want := make(map[uuid.UUID]bool, len(existing))
	for _, id := range existing {
		want[id] = true
	}
	for _, id := range ids {
		if !want[id] {
			return false
		}
		delete(want, id)
	}
	return true
}

func mapErr(err error, entity, key string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound(entity + ".not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apperr.Conflict(entity+".key_taken", "key already exists").With("key", key)
		case "23503":
			return apperr.Conflict(entity+".in_use", "still in use")
		}
	}
	return err
}

// fieldErr maps a field write error; a taken key is a field error at loc.key
// (so the import's answers show it at the right column).
func fieldErr(err error, key, loc string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperr.Validation(apperr.Field(loc+".key", "catalog_field.key_taken", "key already exists").With("key", key))
	}
	return mapErr(err, "catalog_field", key)
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
