// Package tenants manages tenants: the distributor that runs SnapFlow and the
// partner companies that plan projects. Every user belongs to one tenant.
//
// A partner tenant with projects is not deleted but archived (D13): it is
// deactivated, hidden from the list unless includeArchived, cannot be chosen
// for users or projects and can be restored. Project counts come from the
// projects feature through ProjectCounter.
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

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

type Tenant struct {
	ID            uuid.UUID    `json:"id"`
	Name          string       `json:"name"`
	IsDistributor bool         `json:"isDistributor" doc:"The one tenant that runs SnapFlow; home of the admins"`
	IsActive      bool         `json:"isActive" doc:"Users of an inactive tenant cannot log in"`
	ArchivedAt    *time.Time   `json:"archivedAt,omitempty" doc:"Set while the tenant is archived: deleted, but kept for its projects"`
	ProjectCount  int64        `json:"projectCount" doc:"Projects of the tenant: deleting a tenant with projects archives it"`
	Letterhead    Letterhead   `json:"letterhead" doc:"Printed on the tenant's proposals; change it with PUT /api/tenants/{id}/letterhead"`
	CreatedAt     time.Time    `json:"createdAt"`
	UpdatedAt     time.Time    `json:"updatedAt"`
	Can           auth.Actions `json:"can"`
}

type TenantInput struct {
	Name     string `json:"name" minLength:"1" maxLength:"200" example:"Acme Installations"`
	IsActive bool   `json:"isActive"`
}

// ProjectCounter counts the projects of tenants; projects.Service implements
// it. It is set after construction (UseProjects), as projects depend on
// tenants too.
type ProjectCounter interface {
	CountByTenant(ctx context.Context, tenantIDs []uuid.UUID) (map[uuid.UUID]int64, error)
}

type Service struct {
	q        store.Querier
	projects ProjectCounter
	files    *files.Service
}

func NewService(q store.Querier) *Service {
	return &Service{q: q, projects: noProjects{}}
}

// UseProjects sets where project counts come from (app wiring).
func (s *Service) UseProjects(p ProjectCounter) { s.projects = p }

type noProjects struct{}

func (noProjects) CountByTenant(context.Context, []uuid.UUID) (map[uuid.UUID]int64, error) {
	return map[uuid.UUID]int64{}, nil
}

// List returns the tenants, the distributor first; archived ones only with
// includeArchived.
func (s *Service) List(ctx context.Context, includeArchived bool) ([]Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return nil, err
	}
	rows, err := s.q.ListTenants(ctx, includeArchived)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	counts, err := s.projects.CountByTenant(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]Tenant, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
		out[i].ProjectCount = counts[r.ID]
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return Tenant{}, err
	}
	return s.lookupCounted(ctx, id)
}

func (s *Service) lookupCounted(ctx context.Context, id uuid.UUID) (Tenant, error) {
	t, err := s.Lookup(ctx, id)
	return s.withCount(ctx, t, err)
}

func (s *Service) withCount(ctx context.Context, t Tenant, err error) (Tenant, error) {
	if err != nil {
		return Tenant{}, err
	}
	counts, err := s.projects.CountByTenant(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return Tenant{}, err
	}
	t.ProjectCount = counts[t.ID]
	return t, nil
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
	return fromRow(row), nil // a new tenant has no projects
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
	if current.ArchivedAt != nil && in.IsActive {
		return Tenant{}, errArchived()
	}
	row, err := s.q.UpdateTenant(ctx, store.UpdateTenantParams{ID: id, Name: name, IsActive: in.IsActive})
	if errors.Is(err, pgx.ErrNoRows) && in.IsActive {
		// Archived (or deleted) since it was read.
		if t, lerr := s.Lookup(ctx, id); lerr == nil && t.ArchivedAt != nil {
			return Tenant{}, errArchived()
		}
	}
	if err != nil {
		return Tenant{}, mapErr(err, name)
	}
	return s.withCount(ctx, fromRow(row), nil)
}

// Delete removes a partner tenant together with its users, or, when the
// tenant has projects, deactivates and archives it (D13), keeping its users
// and projects. An archived tenant with projects cannot be deleted
// (tenant.has_projects).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return err
	}
	current, err := s.lookupCounted(ctx, id)
	if err != nil {
		return err
	}
	if current.IsDistributor {
		return errDistributorProtected()
	}
	if current.ProjectCount > 0 {
		return s.archive(ctx, current)
	}
	n, err := s.q.DeleteTenant(ctx, id)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		// A project was created since the count: archive instead.
		return s.archive(ctx, current)
	}
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("tenant.not_found")
	}
	return nil
}

func (s *Service) archive(ctx context.Context, t Tenant) error {
	if t.ArchivedAt != nil {
		return apperr.Conflict("tenant.has_projects", "an archived tenant cannot be deleted while it has projects").
			With("count", t.ProjectCount)
	}
	_, err := s.q.ArchiveTenant(ctx, t.ID)
	return mapErr(err, "")
}

// Restore takes an archived tenant out of the archive. It stays inactive
// until it is activated as usual. Restoring a tenant that is not archived
// changes nothing.
func (s *Service) Restore(ctx context.Context, id uuid.UUID) (Tenant, error) {
	if _, err := auth.Require(ctx, auth.PermTenantsManage); err != nil {
		return Tenant{}, err
	}
	row, err := s.q.RestoreTenant(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.lookupCounted(ctx, id)
	}
	if err != nil {
		return Tenant{}, err
	}
	return s.withCount(ctx, fromRow(row), nil)
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

// LookupMany returns the tenants with the given ids (missing ones are left
// out) without a permission check, for other services (the project list's
// tenant names).
func (s *Service) LookupMany(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]Tenant, error) {
	out := make(map[uuid.UUID]Tenant, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.q.GetTenants(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = fromRow(r)
	}
	return out, nil
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

func errArchived() *apperr.Error {
	return apperr.Conflict("tenant.archived", "restore the tenant before activating it")
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
		ID: r.ID, Name: r.Name, IsDistributor: r.IsDistributor, IsActive: r.IsActive, ArchivedAt: r.ArchivedAt,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, Letterhead: letterheadOf(r),
		Can: auth.Actions{Update: true, Delete: !r.IsDistributor},
	}
}
