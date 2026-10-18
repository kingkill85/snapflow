// Package users manages users, their sessions and the logged-in account
// (login, profile, password). Who may do what is defined in platform/auth.
package users

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/features/users/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/password"
	"github.com/kingkill85/snapflow/backend/internal/platform/ratelimit"
)

type User struct {
	ID        uuid.UUID    `json:"id"`
	TenantID  uuid.UUID    `json:"tenantId"`
	Email     string       `json:"email" example:"anna@example.com"`
	FullName  string       `json:"fullName"`
	Role      auth.Role    `json:"role"`
	IsActive  bool         `json:"isActive" doc:"Inactive users cannot log in"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt"`
	Can       auth.Actions `json:"can"`
}

type UserInput struct {
	Email    string     `json:"email" format:"email" maxLength:"254"`
	FullName string     `json:"fullName" maxLength:"200"`
	Role     auth.Role  `json:"role"`
	TenantID *uuid.UUID `json:"tenantId,omitempty" doc:"Defaults to the caller's tenant. Only callers with tenants.access_all may choose another tenant"`
	IsActive bool       `json:"isActive"`
	Password string     `json:"password,omitempty" maxLength:"200" doc:"Required on create. On update, set it to reset the password; this ends the user's sessions"`
}

type Service struct {
	q       store.Querier
	tenants *tenants.Service
	logins  *ratelimit.Limiter
}

func NewService(q store.Querier, tenants *tenants.Service) *Service {
	return &Service{q: q, tenants: tenants, logins: ratelimit.New(10, 5*time.Minute)}
}

// List returns the users the caller may manage. Callers who see every tenant
// may filter by tenantID; everyone else gets their own tenant.
func (s *Service) List(ctx context.Context, tenantID *uuid.UUID) ([]User, error) {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return nil, err
	}
	if !actor.Can(auth.PermTenantsAccessAll) {
		tenantID = &actor.TenantID
	}
	rows, err := s.q.ListUsers(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	out := make([]User, len(rows))
	for i, r := range rows {
		out[i] = toUser(actor, r)
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (User, error) {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return User{}, err
	}
	row, err := s.visible(ctx, actor, id)
	if err != nil {
		return User{}, err
	}
	return toUser(actor, row), nil
}

func (s *Service) Create(ctx context.Context, in UserInput) (User, error) {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return User{}, err
	}
	tenantID := actor.TenantID
	if in.TenantID != nil {
		tenantID = *in.TenantID
	}
	if err := s.checkAssignment(ctx, actor, in.Role, tenantID); err != nil {
		return User{}, err
	}
	if in.Password == "" {
		return User{}, apperr.Invalid("body.password", "validation.required", "password is required")
	}
	hash, err := hashPassword("body.password", in.Password)
	if err != nil {
		return User{}, err
	}
	email := normalizeEmail(in.Email)
	row, err := s.q.CreateUser(ctx, store.CreateUserParams{
		TenantID: tenantID, Email: email, FullName: strings.TrimSpace(in.FullName),
		PasswordHash: hash, Role: in.Role, IsActive: in.IsActive,
	})
	if err != nil {
		return User{}, mapErr(err, email)
	}
	return toUser(actor, row), nil
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in UserInput) (User, error) {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return User{}, err
	}
	current, err := s.visible(ctx, actor, id)
	if err != nil {
		return User{}, err
	}
	if !actor.CanManage(current.Role) {
		return User{}, errTargetForbidden()
	}
	tenantID := current.TenantID
	if in.TenantID != nil {
		tenantID = *in.TenantID
	}
	if err := s.checkAssignment(ctx, actor, in.Role, tenantID); err != nil {
		return User{}, err
	}
	// Nobody can lock themselves out. This also keeps at least one admin:
	// only an admin can change an admin, and not themselves.
	if id == actor.UserID {
		if in.Role != current.Role {
			return User{}, apperr.New(http.StatusConflict, "user.own_role", "you cannot change your own role")
		}
		if !in.IsActive {
			return User{}, apperr.New(http.StatusConflict, "user.own_deactivation", "you cannot deactivate yourself")
		}
		if tenantID != current.TenantID {
			return User{}, apperr.New(http.StatusConflict, "user.own_tenant", "you cannot move yourself to another tenant")
		}
	}
	var hash string
	if in.Password != "" {
		if hash, err = hashPassword("body.password", in.Password); err != nil {
			return User{}, err
		}
	}

	email := normalizeEmail(in.Email)
	row, err := s.q.UpdateUser(ctx, store.UpdateUserParams{
		ID: id, TenantID: tenantID, Email: email, FullName: strings.TrimSpace(in.FullName),
		Role: in.Role, IsActive: in.IsActive,
	})
	if err != nil {
		return User{}, mapErr(err, email)
	}
	if hash != "" {
		if err := s.setPassword(ctx, id, hash, nil); err != nil {
			return User{}, err
		}
	}
	return toUser(actor, row), nil
}

func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return err
	}
	current, err := s.visible(ctx, actor, id)
	if err != nil {
		return err
	}
	if id == actor.UserID {
		return apperr.New(http.StatusConflict, "user.own_delete", "you cannot delete yourself")
	}
	if !actor.CanManage(current.Role) {
		return errTargetForbidden()
	}
	if _, err := s.q.DeleteUser(ctx, id); err != nil {
		return err
	}
	return nil
}

// Bootstrap prepares an empty installation: it makes sure the distributor
// tenant exists and, when there is no active admin, creates one from the
// given credentials (skipped if email is empty). It runs at startup.
func (s *Service) Bootstrap(ctx context.Context, distributorName, email, pw string) error {
	distributor, err := s.tenants.EnsureDistributor(ctx, distributorName)
	if err != nil {
		return err
	}
	if email == "" {
		return nil
	}
	admins, err := s.q.CountActiveAdmins(ctx)
	if err != nil || admins > 0 {
		return err
	}
	hash, err := hashPassword("ADMIN_PASSWORD", pw)
	if err != nil {
		return err
	}
	_, err = s.q.CreateUser(ctx, store.CreateUserParams{
		TenantID: distributor.ID, Email: normalizeEmail(email), FullName: "Administrator",
		PasswordHash: hash, Role: auth.RoleAdmin, IsActive: true,
	})
	return mapErr(err, email)
}

// visible loads a user the actor may see; others look like they do not exist.
func (s *Service) visible(ctx context.Context, actor auth.Actor, id uuid.UUID) (store.User, error) {
	row, err := s.q.GetUser(ctx, id)
	if err != nil {
		return store.User{}, mapErr(err, "")
	}
	if !actor.SeesTenant(row.TenantID) {
		return store.User{}, apperr.NotFound("user.not_found")
	}
	return row, nil
}

// checkAssignment enforces who may give which role in which tenant.
func (s *Service) checkAssignment(ctx context.Context, actor auth.Actor, role auth.Role, tenantID uuid.UUID) error {
	if !actor.CanAssign(role) {
		return apperr.New(http.StatusForbidden, "user.role_forbidden", "you cannot assign this role").With("role", string(role))
	}
	if !actor.SeesTenant(tenantID) {
		return apperr.New(http.StatusForbidden, "user.tenant_forbidden", "you cannot manage users of another tenant")
	}
	tenant, err := s.tenants.Lookup(ctx, tenantID)
	if err != nil {
		var ae *apperr.Error
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
			return apperr.Invalid("body.tenantId", "user.tenant_not_found", "tenant does not exist")
		}
		return err
	}
	if role == auth.RoleAdmin && !tenant.IsDistributor {
		return apperr.Invalid("body.role", "user.admin_requires_distributor", "admins must belong to the distributor tenant")
	}
	return nil
}

func hashPassword(location, pw string) (string, error) {
	if len([]rune(pw)) < password.MinLength {
		return "", apperr.Invalid(location, "user.password_too_short", "password is too short")
	}
	return password.Hash(pw)
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func errTargetForbidden() *apperr.Error {
	return apperr.New(http.StatusForbidden, "user.target_forbidden", "you cannot change a user with a higher role")
}

func mapErr(err error, email string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("user.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperr.Conflict("user.email_taken", "email already in use").With("email", email)
	}
	return err
}

func toUser(actor auth.Actor, r store.User) User {
	manage := actor.CanManage(r.Role)
	return User{
		ID: r.ID, TenantID: r.TenantID, Email: r.Email, FullName: r.FullName, Role: r.Role,
		IsActive: r.IsActive, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: manage, Delete: manage && r.ID != actor.UserID},
	}
}
