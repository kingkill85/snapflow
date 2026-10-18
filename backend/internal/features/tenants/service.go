// Package tenants manages tenants: the distributor that runs SnapFlow and the
// partner companies that plan projects. Every user belongs to one tenant.
package tenants

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

type Tenant struct {
	ID            uuid.UUID    `json:"id"`
	Name          string       `json:"name"`
	IsDistributor bool         `json:"isDistributor" doc:"The one tenant that runs SnapFlow; home of the admins"`
	IsActive      bool         `json:"isActive" doc:"Users of an inactive tenant cannot log in"`
	CreatedAt     time.Time    `json:"createdAt"`
	UpdatedAt     time.Time    `json:"updatedAt"`
	Can           auth.Actions `json:"can"`
}

type TenantInput struct {
	Name     string `json:"name" minLength:"1" maxLength:"200" example:"Acme Installations"`
	IsActive bool   `json:"isActive"`
}

type Service struct {
	q store.Querier
}

func NewService(q store.Querier) *Service {
	return &Service{q: q}
}

func (s *Service) List(ctx context.Context) ([]Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return nil, err
	}
	rows, err := s.q.ListTenants(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Tenant, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return Tenant{}, err
	}
	return s.Lookup(ctx, id)
}

func (s *Service) Create(ctx context.Context, in TenantInput) (Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return Tenant{}, err
	}
	name, err := validate(in)
	if err != nil {
		return Tenant{}, err
	}
	row, err := s.q.CreateTenant(ctx, store.CreateTenantParams{Name: name, IsActive: in.IsActive})
	if err != nil {
		return Tenant{}, mapErr(err, name)
	}
	return fromRow(row), nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in TenantInput) (Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return Tenant{}, err
	}
	name, err := validate(in)
	if err != nil {
		return Tenant{}, err
	}
	current, err := s.Lookup(ctx, id)
	if err != nil {
		return Tenant{}, err
	}
	if current.IsDistributor && !in.IsActive {
		return Tenant{}, errDistributorProtected()
	}
	row, err := s.q.UpdateTenant(ctx, store.UpdateTenantParams{ID: id, Name: name, IsActive: in.IsActive})
	if err != nil {
		return Tenant{}, mapErr(err, name)
	}
	return fromRow(row), nil
}

// Delete removes a partner tenant together with its users.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return err
	}
	current, err := s.Lookup(ctx, id)
	if err != nil {
		return err
	}
	if current.IsDistributor {
		return errDistributorProtected()
	}
	n, err := s.q.DeleteTenant(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("tenant.not_found")
	}
	return nil
}

// Lookup returns a tenant without a permission check. It is for other
// services (login, user management), never for direct exposure.
func (s *Service) Lookup(ctx context.Context, id uuid.UUID) (Tenant, error) {
	row, err := s.q.GetTenant(ctx, id)
	if err != nil {
		return Tenant{}, mapErr(err, "")
	}
	return fromRow(row), nil
}

// EnsureDistributor returns the distributor tenant, creating it with name if
// there is none yet. Called at startup.
func (s *Service) EnsureDistributor(ctx context.Context, name string) (Tenant, error) {
	row, err := s.q.GetDistributor(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		row, err = s.q.CreateTenant(ctx, store.CreateTenantParams{Name: name, IsDistributor: true, IsActive: true})
	}
	if err != nil {
		return Tenant{}, err
	}
	return fromRow(row), nil
}

func validate(in TenantInput) (string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return "", apperr.Invalid("body.name", "validation.required", "name is required")
	}
	return name, nil
}

func errDistributorProtected() *apperr.Error {
	return apperr.New(http.StatusConflict, "tenant.distributor_protected", "the distributor tenant cannot be deactivated or deleted")
}

func mapErr(err error, name string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("tenant.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperr.Conflict("tenant.name_taken", "name already exists").With("name", name)
	}
	return err
}

func fromRow(r store.Tenant) Tenant {
	return Tenant{
		ID: r.ID, Name: r.Name, IsDistributor: r.IsDistributor, IsActive: r.IsActive,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: true, Delete: !r.IsDistributor},
	}
}
