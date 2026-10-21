// Package functiontypes manages function types: the shared vocabulary of
// demand and supply (dimmer, switching, blind, ...). Loads in zones need a
// function type; module channels provide one.
package functiontypes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

type FunctionType struct {
	ID   uuid.UUID `json:"id"`
	Key  string    `json:"key" doc:"Stable identifier, lower snake case" example:"dimmer"`
	Name i18n.Text `json:"name" doc:"Display name per locale"`
	// AllowsCircuit: several needs of this function may share one channel
	// (lights, sockets: yes; blinds, inputs: no).
	AllowsCircuit bool        `json:"allowsCircuit" doc:"Several needs of this function may share one channel (a circuit)"`
	LoadTypeIDs   []uuid.UUID `json:"loadTypeIds" doc:"The load types a need of this function may have; empty = any"`
	IsActive      bool        `json:"isActive" doc:"Inactive: kept on existing needs (with a warning), not chosen for new ones"`
	KNXObjects    []KNXObject `json:"knxObjects" doc:"The KNX communication objects of a need of this function (one group address each)"`
	OutputKindIDs []uuid.UUID `json:"outputKindIds" doc:"The output (channel) kinds that serve this function, in their order; empty = needs of it cannot be connected"`
	CreatedAt     time.Time   `json:"createdAt"`
	UpdatedAt     time.Time   `json:"updatedAt"`
}

type FunctionTypeInput struct {
	Key           string      `json:"key" minLength:"1" maxLength:"64" example:"dimmer"`
	Name          i18n.Text   `json:"name" doc:"Display name per locale; \"en\" is required"`
	AllowsCircuit *bool       `json:"allowsCircuit,omitempty" doc:"Several needs may share one channel (default false); on update, left out keeps the stored value (D294)"`
	LoadTypeIDs   []uuid.UUID `json:"loadTypeIds,omitempty" maxItems:"200" doc:"Allowed load types (existing ones, each once); empty = any; on update, left out keeps the stored ones (D294)"`
	IsActive      *bool       `json:"isActive,omitempty" doc:"Default true; on update, left out keeps the stored value (D294)"`
	KNXObjects    []KNXObject `json:"knxObjects,omitempty" maxItems:"32" doc:"KNX communication objects (keys unique); on update, left out keeps the stored ones (D294)"`
	OutputKindIDs []uuid.UUID `json:"outputKindIds,omitempty" maxItems:"200" doc:"The output kinds serving this function (existing ones, each once); on update, left out keeps the stored links, empty clears them (D444)"`
}

// ServedBy reads and replaces which output kinds serve a function type.
// The capabilities feature owns those links and registers an
// implementation at wiring time (SetServedBy); functiontypes does not read
// its tables (D444, like plans.ContentHook, D243). tx nil: outside a
// transaction.
type ServedBy interface {
	ListServedBy(ctx context.Context, tx pgx.Tx) (map[uuid.UUID][]uuid.UUID, error)
	SetServedBy(ctx context.Context, tx pgx.Tx, functionTypeID uuid.UUID, outputKindIDs []uuid.UUID) error
}

// KNXObject is a KNX communication object of a function: a group address
// per need in the KNX export (D422).
type KNXObject struct {
	Key  string    `json:"key" minLength:"1" maxLength:"64" example:"switch_status" doc:"Stable identifier, lower snake case, unique per function type"`
	Name i18n.Text `json:"name" doc:"Object name per locale (part of the group address name); \"en\" is required"`
	DPST string    `json:"dpst" maxLength:"32" example:"DPST-1-1" doc:"ETS datapoint subtype"`
}

// MaxKNXObjects bounds the objects of a function type.
const MaxKNXObjects = 32

var dpstPattern = regexp.MustCompile(`^DPST-\d{1,3}-\d{1,5}$`)

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db       DB
	q        *store.Queries
	servedBy ServedBy
}

// SetServedBy registers the owner of the output kind links (capabilities).
func (s *Service) SetServedBy(h ServedBy) { s.servedBy = h }

func NewService(db DB) *Service {
	return &Service{db: db, q: store.New(db)}
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// served returns the output kinds serving each function type (empty
// without a registered hook).
func (s *Service) served(ctx context.Context, tx pgx.Tx) (map[uuid.UUID][]uuid.UUID, error) {
	if s.servedBy == nil {
		return map[uuid.UUID][]uuid.UUID{}, nil
	}
	return s.servedBy.ListServedBy(ctx, tx)
}

// setServed replaces the serving output kinds; nil keeps them.
func (s *Service) setServed(ctx context.Context, tx pgx.Tx, id uuid.UUID, kindIDs []uuid.UUID) error {
	if kindIDs == nil {
		return nil
	}
	if s.servedBy == nil {
		return errors.New("functiontypes: outputKindIds given but no ServedBy hook is registered")
	}
	return s.servedBy.SetServedBy(ctx, tx, id, kindIDs)
}

// loadTypes returns the allowed load types of every function type.
func (s *Service) loadTypes(ctx context.Context) (map[uuid.UUID][]uuid.UUID, error) {
	links, err := s.q.ListFunctionTypeLoadTypes(ctx)
	if err != nil {
		return nil, err
	}
	out := map[uuid.UUID][]uuid.UUID{}
	for _, l := range links {
		out[l.FunctionTypeID] = append(out[l.FunctionTypeID], l.LoadTypeID)
	}
	return out, nil
}

func (s *Service) List(ctx context.Context) ([]FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	rows, err := s.q.ListFunctionTypes(ctx)
	if err != nil {
		return nil, err
	}
	loads, err := s.loadTypes(ctx)
	if err != nil {
		return nil, err
	}
	served, err := s.served(ctx, nil)
	if err != nil {
		return nil, err
	}
	out := make([]FunctionType, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, loads[r.ID], served[r.ID])
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return FunctionType{}, err
	}
	row, err := s.q.GetFunctionType(ctx, id)
	if err != nil {
		return FunctionType{}, mapErr(err)
	}
	loads, err := s.loadTypes(ctx)
	if err != nil {
		return FunctionType{}, err
	}
	served, err := s.served(ctx, nil)
	if err != nil {
		return FunctionType{}, err
	}
	return fromRow(row, loads[row.ID], served[row.ID]), nil
}

func (s *Service) Create(ctx context.Context, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	// Names are stored trimmed, blank translations dropped (as for the other catalog texts).
	in.Name = in.Name.Trimmed()
	in.KNXObjects = trimObjects(in.KNXObjects)
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	objects, err := marshalObjects(in.KNXObjects)
	if err != nil {
		return FunctionType{}, err
	}
	if objects == nil {
		objects = []byte("[]")
	}
	var row store.FunctionType
	var served []uuid.UUID
	err = s.inTx(ctx, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		row, err = q.CreateFunctionType(ctx, store.CreateFunctionTypeParams{Key: in.Key, Name: in.Name,
			AllowsCircuit: in.AllowsCircuit != nil && *in.AllowsCircuit, IsActive: in.IsActive == nil || *in.IsActive, KnxObjects: objects})
		if err != nil {
			return err
		}
		if err := setLoadTypes(ctx, q, row.ID, in.LoadTypeIDs); err != nil {
			return err
		}
		if err := s.setServed(ctx, tx, row.ID, in.OutputKindIDs); err != nil {
			return err
		}
		all, err := s.served(ctx, tx)
		served = all[row.ID]
		return err
	})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	return fromRow(row, in.LoadTypeIDs, served), nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	// Names are stored trimmed, blank translations dropped (as for the other catalog texts).
	in.Name = in.Name.Trimmed()
	in.KNXObjects = trimObjects(in.KNXObjects)
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	objects, err := marshalObjects(in.KNXObjects)
	if err != nil {
		return FunctionType{}, err
	}
	var row store.FunctionType
	var served []uuid.UUID
	err = s.inTx(ctx, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		// Left-out flags keep the stored values (D294).
		allowsCircuit, isActive := in.AllowsCircuit, in.IsActive
		if allowsCircuit == nil || isActive == nil {
			current, err := q.GetFunctionType(ctx, id)
			if err != nil {
				return err
			}
			if allowsCircuit == nil {
				allowsCircuit = &current.AllowsCircuit
			}
			if isActive == nil {
				isActive = &current.IsActive
			}
		}
		row, err = q.UpdateFunctionType(ctx, store.UpdateFunctionTypeParams{ID: id, Key: in.Key, Name: in.Name,
			AllowsCircuit: *allowsCircuit, IsActive: *isActive, KnxObjects: objects})
		if err != nil {
			return err
		}
		if in.LoadTypeIDs != nil {
			if err := q.DeleteFunctionTypeLoadTypes(ctx, id); err != nil {
				return err
			}
			if err := setLoadTypes(ctx, q, id, in.LoadTypeIDs); err != nil {
				return err
			}
		}
		if err := s.setServed(ctx, tx, id, in.OutputKindIDs); err != nil {
			return err
		}
		all, err := s.served(ctx, tx)
		served = all[id]
		return err
	})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	if in.LoadTypeIDs == nil {
		loads, err := s.loadTypes(ctx)
		if err != nil {
			return FunctionType{}, err
		}
		return fromRow(row, loads[id], served), nil
	}
	return fromRow(row, in.LoadTypeIDs, served), nil
}

func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	n, err := s.q.DeleteFunctionType(ctx, id)
	if err != nil {
		return mapErr(err)
	}
	if n == 0 {
		return apperr.NotFound("function_type.not_found")
	}
	return nil
}

func validate(in FunctionTypeInput) error {
	var errs []apperr.FieldError
	if !keyPattern.MatchString(in.Key) {
		errs = append(errs, apperr.Field("body.key", "function_type.key_format", "key must be lower snake case"))
	}
	errs = append(errs, in.Name.Check("body.name", 0)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field("body.name.en", "validation.required", "English name is required"))
	}
	seen := map[uuid.UUID]bool{}
	for i, id := range in.LoadTypeIDs {
		if seen[id] {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.loadTypeIds[%d]", i), "function_type.load_type_duplicate", "listed twice"))
		}
		seen[id] = true
	}
	seenKinds := map[uuid.UUID]bool{}
	for i, id := range in.OutputKindIDs {
		if seenKinds[id] {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.outputKindIds[%d]", i), "function_type.output_kind_duplicate", "listed twice"))
		}
		seenKinds[id] = true
	}
	if len(in.KNXObjects) > MaxKNXObjects {
		errs = append(errs, apperr.Field("body.knxObjects", "validation.too_many", "too many objects").With("max", MaxKNXObjects))
	}
	keys := map[string]bool{}
	for i, o := range in.KNXObjects {
		at := fmt.Sprintf("body.knxObjects[%d]", i)
		switch {
		case !keyPattern.MatchString(o.Key):
			errs = append(errs, apperr.Field(at+".key", "function_type.key_format", "key must be lower snake case"))
		case keys[o.Key]:
			errs = append(errs, apperr.Field(at+".key", "function_type.knx_object_duplicate", "object key listed twice").With("key", o.Key))
		}
		keys[o.Key] = true
		errs = append(errs, o.Name.Check(at+".name", 100)...)
		if !o.Name.Valid() {
			errs = append(errs, apperr.Field(at+".name.en", "validation.required", "English name is required"))
		}
		if !dpstPattern.MatchString(o.DPST) {
			errs = append(errs, apperr.Field(at+".dpst", "function_type.dpst_format", "datapoint subtype like DPST-1-1"))
		}
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
}

func trimObjects(os []KNXObject) []KNXObject {
	for i := range os {
		os[i].Key = strings.TrimSpace(os[i].Key)
		os[i].Name = os[i].Name.Trimmed()
		os[i].DPST = strings.TrimSpace(os[i].DPST)
	}
	return os
}

// marshalObjects: nil for nil (keep the stored objects on update).
func marshalObjects(os []KNXObject) ([]byte, error) {
	if os == nil {
		return nil, nil
	}
	return json.Marshal(os)
}

func objectsOf(raw []byte) []KNXObject {
	var out []KNXObject
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			slog.Warn("function type: knx objects unreadable", "error", err)
		}
	}
	if out == nil {
		out = []KNXObject{}
	}
	return out
}

func mapErr(err error, key ...string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("function_type.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && len(key) > 0 {
		return apperr.Conflict("function_type.key_taken", "key already exists").With("key", key[0])
	}
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		// Output kinds serve the function type, needs or room templates use
		// it (function_type_load_types cascades; an unknown load type is
		// caught in setLoadTypes).
		return apperr.Conflict("function_type.in_use", "output kinds, needs or room templates still use this function type")
	}
	return err
}

// setLoadTypes stores the allowed load types; an unknown one is
// load_type.not_found (from the foreign key).
func setLoadTypes(ctx context.Context, q *store.Queries, id uuid.UUID, loadTypeIDs []uuid.UUID) error {
	if len(loadTypeIDs) == 0 {
		return nil
	}
	err := q.InsertFunctionTypeLoadTypes(ctx, store.InsertFunctionTypeLoadTypesParams{FunctionTypeID: id, LoadTypeIds: loadTypeIDs})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return apperr.Validation(apperr.Field("body.loadTypeIds", "load_type.not_found", "a load type does not exist"))
	}
	return err
}

func fromRow(r store.FunctionType, loadTypes, served []uuid.UUID) FunctionType {
	if loadTypes == nil {
		loadTypes = []uuid.UUID{}
	}
	if served == nil {
		served = []uuid.UUID{}
	}
	return FunctionType{ID: r.ID, Key: r.Key, Name: r.Name, AllowsCircuit: r.AllowsCircuit, LoadTypeIDs: loadTypes,
		IsActive: r.IsActive, KNXObjects: objectsOf(r.KnxObjects), OutputKindIDs: served, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}
