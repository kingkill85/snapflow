// Package functiontypes manages function types: the shared vocabulary of
// demand and supply (dimmer, switching, blind, ...). Loads in zones need a
// function type; module channels provide one.
package functiontypes

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

type FunctionType struct {
	ID        uuid.UUID `json:"id"`
	Key       string    `json:"key" doc:"Stable identifier, lower snake case" example:"dimmer"`
	Name      i18n.Text `json:"name" doc:"Display name per locale"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type FunctionTypeInput struct {
	Key  string    `json:"key" minLength:"1" maxLength:"64" example:"dimmer"`
	Name i18n.Text `json:"name" doc:"Display name per locale; \"en\" is required"`
}

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

type Service struct {
	q store.Querier
}

func NewService(q store.Querier) *Service {
	return &Service{q: q}
}

func (s *Service) List(ctx context.Context) ([]FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogRead); err != nil {
		return nil, err
	}
	rows, err := s.q.ListFunctionTypes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]FunctionType, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
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
	return fromRow(row), nil
}

func (s *Service) Create(ctx context.Context, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	row, err := s.q.CreateFunctionType(ctx, store.CreateFunctionTypeParams{Key: in.Key, Name: in.Name})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	return fromRow(row), nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in FunctionTypeInput) (FunctionType, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return FunctionType{}, err
	}
	if err := validate(in); err != nil {
		return FunctionType{}, err
	}
	row, err := s.q.UpdateFunctionType(ctx, store.UpdateFunctionTypeParams{ID: id, Key: in.Key, Name: in.Name})
	if err != nil {
		return FunctionType{}, mapErr(err, in.Key)
	}
	return fromRow(row), nil
}

func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	n, err := s.q.DeleteFunctionType(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("function_type.not_found")
	}
	return nil
}

func validate(in FunctionTypeInput) error {
	if !keyPattern.MatchString(in.Key) {
		return apperr.Invalid("body.key", "function_type.key_format", "key must be lower snake case")
	}
	if !in.Name.Valid() {
		return apperr.Invalid("body.name.en", "validation.required", "English name is required")
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
	return err
}

func fromRow(r store.FunctionType) FunctionType {
	return FunctionType{ID: r.ID, Key: r.Key, Name: r.Name, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}
