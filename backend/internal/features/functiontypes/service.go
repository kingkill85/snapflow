// Package functiontypes manages function types: the shared vocabulary of
// demand and supply (dimmer, switching, blind, ...). Loads in zones need a
// function type; module channels provide one.
package functiontypes

import (
	"context"
	"errors"
	"fmt"
	"regexp"
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
	CreatedAt     time.Time   `json:"createdAt"`
	UpdatedAt     time.Time   `json:"updatedAt"`
}

type FunctionTypeInput struct {
	Key           string      `json:"key" minLength:"1" maxLength:"64" example:"dimmer"`
	Name          i18n.Text   `json:"name" doc:"Display name per locale; \"en\" is required"`
	AllowsCircuit bool        `json:"allowsCircuit,omitempty" doc:"Several needs may share one channel (default false)"`
	LoadTypeIDs   []uuid.UUID `json:"loadTypeIds,omitempty" maxItems:"200" doc:"Allowed load types (existing ones, each once); empty = any"`
}

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db DB
	q  *store.Queries
}

func NewService(db DB) *Service {
	return &Service{db: db, q: store.New(db)}
}

func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
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
	out := make([]FunctionType, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, loads[r.ID])
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
	return fromRow(row, loads[row.ID]), nil
}

func (s *Service) Create(ctx context.Context, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	// Names are stored trimmed, blank translations dropped (as for the other catalog texts).
	in.Name = in.Name.Trimmed()
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	var row store.FunctionType
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.CreateFunctionType(ctx, store.CreateFunctionTypeParams{Key: in.Key, Name: in.Name, AllowsCircuit: in.AllowsCircuit})
		if err != nil {
			return err
		}
		return setLoadTypes(ctx, q, row.ID, in.LoadTypeIDs)
	})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	return fromRow(row, in.LoadTypeIDs), nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	// Names are stored trimmed, blank translations dropped (as for the other catalog texts).
	in.Name = in.Name.Trimmed()
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	var row store.FunctionType
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateFunctionType(ctx, store.UpdateFunctionTypeParams{ID: id, Key: in.Key, Name: in.Name, AllowsCircuit: in.AllowsCircuit})
		if err != nil {
			return err
		}
		if err := q.DeleteFunctionTypeLoadTypes(ctx, id); err != nil {
			return err
		}
		return setLoadTypes(ctx, q, id, in.LoadTypeIDs)
	})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	return fromRow(row, in.LoadTypeIDs), nil
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
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
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
		// Output kinds serve the function type (function_type_load_types
		// cascades; an unknown load type is caught in setLoadTypes).
		return apperr.Conflict("function_type.in_use", "output kinds still serve this function type")
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

func fromRow(r store.FunctionType, loadTypes []uuid.UUID) FunctionType {
	if loadTypes == nil {
		loadTypes = []uuid.UUID{}
	}
	return FunctionType{ID: r.ID, Key: r.Key, Name: r.Name, AllowsCircuit: r.AllowsCircuit, LoadTypeIDs: loadTypes,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}
