// Package users manages users, their sessions and the logged-in account
// (login, profile, password). Who may do what is defined in platform/auth.
package users

import (
	"context"
	"errors"
	"log/slog"
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
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
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

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// Failed attempts are counted in fixed windows of limitPeriod (see Login).
const limitPeriod = 5 * time.Minute

type Service struct {
	db      DB
	q       *store.Queries
	tenants *tenants.Service

	// Failed logins per (email, client IP), per email and per client IP.
	loginPairFailures  *ratelimit.Limiter
	loginEmailFailures *ratelimit.Limiter
	loginIPFailures    *ratelimit.Limiter
	// Wrong current passwords per user (ChangePassword).
	passwordFailures *ratelimit.Limiter
}

func NewService(db DB, tenants *tenants.Service) *Service {
	return &Service{
		db: db, q: store.New(db), tenants: tenants,
		loginPairFailures:  ratelimit.New(10, limitPeriod),
		loginEmailFailures: ratelimit.New(50, limitPeriod),
		loginIPFailures:    ratelimit.New(100, limitPeriod),
		passwordFailures:   ratelimit.New(10, limitPeriod),
	}
}

// inTx runs fn in one transaction; any error rolls it back. A transaction
// aborted by a deadlock or serialization failure is run again (at most
// database.TxAttempts times, then 409 request.conflict_retry), so fn must be
// safe to repeat.
func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
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
	if err := s.checkAssignment(ctx, actor, in.Role, tenantID, nil); err != nil {
		return User{}, err
	}
	if in.Password == "" {
		return User{}, apperr.Invalid("body.password", "validation.required", "password is required")
	}
	hash, err := hashPassword(ctx, "body.password", in.Password)
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

// Update changes a user. It runs in one transaction with the user's row
// locked, so concurrent changes cannot together remove the last admin.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in UserInput) (User, error) {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return User{}, err
	}
	before, err := s.visible(ctx, actor, id)
	if err != nil {
		return User{}, err
	}
	var hash string
	if in.Password != "" {
		if id == actor.UserID {
			return User{}, apperr.New(http.StatusConflict, "user.own_password", "use your profile to change your own password")
		}
		// Hash before the transaction, so no lock is held meanwhile.
		if hash, err = hashPassword(ctx, "body.password", in.Password); err != nil {
			return User{}, err
		}
	}
	email := normalizeEmail(in.Email)
	// The tenant is looked up before the transaction (D243); a user moved
	// to another tenant meanwhile makes the update retry.
	wantTenant := before.TenantID
	if in.TenantID != nil {
		wantTenant = *in.TenantID
	}
	tenant, lookupErr := s.tenants.Lookup(ctx, wantTenant)

	var out User
	err = s.inTx(ctx, func(q *store.Queries) error {
		admins, err := s.lockAdminsIf(ctx, q, isActiveAdmin(before))
		if err != nil {
			return err
		}
		current, err := s.visibleForUpdate(ctx, q, actor, id)
		if err != nil {
			return err
		}
		if !actor.CanManage(current.Role) {
			return errTargetForbidden()
		}
		tenantID := current.TenantID
		if in.TenantID != nil {
			tenantID = *in.TenantID
		}
		// Nobody can lock themselves out.
		if id == actor.UserID {
			if in.Role != current.Role {
				return apperr.New(http.StatusConflict, "user.own_role", "you cannot change your own role")
			}
			if !in.IsActive {
				return apperr.New(http.StatusConflict, "user.own_deactivation", "you cannot deactivate yourself")
			}
			if tenantID != current.TenantID {
				return apperr.New(http.StatusConflict, "user.own_tenant", "you cannot move yourself to another tenant")
			}
		}
		if tenantID != wantTenant {
			return apperr.ConflictRetry()
		}
		if err := checkAssignment(actor, in.Role, tenantID, &current.TenantID, tenant, lookupErr); err != nil {
			return err
		}
		if isActiveAdmin(current) && (in.Role != auth.RoleAdmin || !in.IsActive) {
			if err := s.keepAnAdmin(ctx, q, admins, id); err != nil {
				return err
			}
		}
		row, err := q.UpdateUser(ctx, store.UpdateUserParams{
			ID: id, TenantID: tenantID, Email: email, FullName: strings.TrimSpace(in.FullName),
			Role: in.Role, IsActive: in.IsActive,
		})
		if err != nil {
			return mapErr(err, email)
		}
		if hash != "" {
			if err := setPassword(ctx, q, id, hash, nil); err != nil {
				return err
			}
		}
		out = toUser(actor, row)
		return nil
	})
	return out, err
}

// Delete removes a user, in one transaction like Update.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermUsersManage)
	if err != nil {
		return err
	}
	before, err := s.visible(ctx, actor, id)
	if err != nil {
		return err
	}
	if id == actor.UserID {
		return apperr.New(http.StatusConflict, "user.own_delete", "you cannot delete yourself")
	}
	return s.inTx(ctx, func(q *store.Queries) error {
		admins, err := s.lockAdminsIf(ctx, q, isActiveAdmin(before))
		if err != nil {
			return err
		}
		current, err := s.visibleForUpdate(ctx, q, actor, id)
		if err != nil {
			return err
		}
		if !actor.CanManage(current.Role) {
			return errTargetForbidden()
		}
		if isActiveAdmin(current) {
			if err := s.keepAnAdmin(ctx, q, admins, id); err != nil {
				return err
			}
		}
		n, err := q.DeleteUser(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return apperr.NotFound("user.not_found")
		}
		return nil
	})
}

// lockAdminsIf locks the active admin rows when cond holds. Callers lock
// them before the target row, so two transactions that both touch admins
// always lock in the same order and queue instead of deadlocking.
func (s *Service) lockAdminsIf(ctx context.Context, q *store.Queries, cond bool) ([]uuid.UUID, error) {
	if !cond {
		return nil, nil
	}
	return q.LockActiveAdmins(ctx)
}

// keepAnAdmin refuses a change that would leave no active admin besides
// the user id. admins are the locked active admins, or nil if not yet locked.
func (s *Service) keepAnAdmin(ctx context.Context, q *store.Queries, admins []uuid.UUID, id uuid.UUID) error {
	if admins == nil {
		var err error
		if admins, err = q.LockActiveAdmins(ctx); err != nil {
			return err
		}
	}
	for _, a := range admins {
		if a != id {
			return nil
		}
	}
	return apperr.New(http.StatusConflict, "user.last_admin", "at least one active admin must remain")
}

func isActiveAdmin(u store.User) bool { return u.Role == auth.RoleAdmin && u.IsActive }

// Bootstrap prepares an installation at startup: it makes sure the
// distributor tenant exists and, when there is no active admin, makes email
// an admin with password pw. An existing user with that email is promoted
// (moved to the distributor, activated, password reset); otherwise the user
// is created.
func (s *Service) Bootstrap(ctx context.Context, distributorName, email, pw string) error {
	distributor, err := s.tenants.EnsureDistributor(ctx, distributorName)
	if err != nil {
		return err
	}
	admins, err := s.q.CountActiveAdmins(ctx)
	if err != nil || admins > 0 {
		return err
	}
	email = normalizeEmail(email)
	if email == "" {
		slog.WarnContext(ctx, "bootstrap: there is no active admin; set ADMIN_EMAIL and ADMIN_PASSWORD to create one")
		return nil
	}
	hash, err := hashPassword(ctx, "ADMIN_PASSWORD", pw)
	if err != nil {
		return err
	}
	existing, err := s.q.GetUserByEmail(ctx, email)
	switch {
	case err == nil:
		err = s.inTx(ctx, func(q *store.Queries) error {
			if _, err := q.PromoteToAdmin(ctx, store.PromoteToAdminParams{
				ID: existing.ID, TenantID: distributor.ID, PasswordHash: hash,
			}); err != nil {
				return err
			}
			return q.DeleteUserSessions(ctx, store.DeleteUserSessionsParams{UserID: existing.ID})
		})
		if err != nil {
			return err
		}
		slog.WarnContext(ctx, "bootstrap: no active admin; promoted the existing user ADMIN_EMAIL to admin and reset their password",
			"email", email, "user_id", existing.ID, "previous_role", existing.Role, "previous_tenant_id", existing.TenantID)
		return nil
	case errors.Is(err, pgx.ErrNoRows):
		row, err := s.q.CreateUser(ctx, store.CreateUserParams{
			TenantID: distributor.ID, Email: email, FullName: "Administrator",
			PasswordHash: hash, Role: auth.RoleAdmin, IsActive: true,
		})
		if err != nil {
			return mapErr(err, email)
		}
		slog.InfoContext(ctx, "bootstrap: created the first admin", "email", email, "user_id", row.ID)
		return nil
	default:
		return err
	}
}

// visible loads a user the actor may see; others look like they do not exist.
func (s *Service) visible(ctx context.Context, actor auth.Actor, id uuid.UUID) (store.User, error) {
	row, err := s.q.GetUser(ctx, id)
	return checkVisible(actor, row, err)
}

// visibleForUpdate is visible with the row locked until the transaction ends.
func (s *Service) visibleForUpdate(ctx context.Context, q *store.Queries, actor auth.Actor, id uuid.UUID) (store.User, error) {
	row, err := q.GetUserForUpdate(ctx, id)
	return checkVisible(actor, row, err)
}

func checkVisible(actor auth.Actor, row store.User, err error) (store.User, error) {
	if err != nil {
		return store.User{}, mapErr(err, "")
	}
	if !actor.SeesTenant(row.TenantID) {
		return store.User{}, apperr.NotFound("user.not_found")
	}
	return row, nil
}

// checkAssignment enforces who may give which role in which tenant. An
// archived tenant (D13) takes no new users: it counts as unknown unless the
// user already belongs to it (currentTenant).
func (s *Service) checkAssignment(ctx context.Context, actor auth.Actor, role auth.Role, tenantID uuid.UUID, currentTenant *uuid.UUID) error {
	tenant, err := s.tenants.Lookup(ctx, tenantID)
	return checkAssignment(actor, role, tenantID, currentTenant, tenant, err)
}

// checkAssignment is the check with the tenant already looked up (lookupErr
// its error), so a transaction never reads through another service's pool
// connection (D243).
func checkAssignment(actor auth.Actor, role auth.Role, tenantID uuid.UUID, currentTenant *uuid.UUID, tenant tenants.Tenant, lookupErr error) error {
	if !actor.CanAssign(role) {
		return apperr.New(http.StatusForbidden, "user.role_forbidden", "you cannot assign this role").With("role", string(role))
	}
	if !actor.SeesTenant(tenantID) {
		return apperr.New(http.StatusForbidden, "user.tenant_forbidden", "you cannot manage users of another tenant")
	}
	if lookupErr != nil {
		var ae *apperr.Error
		if errors.As(lookupErr, &ae) && ae.Status == http.StatusNotFound {
			return apperr.Invalid("body.tenantId", "user.tenant_not_found", "tenant does not exist")
		}
		return lookupErr
	}
	if tenant.ArchivedAt != nil && (currentTenant == nil || *currentTenant != tenantID) {
		return apperr.Invalid("body.tenantId", "user.tenant_not_found", "tenant does not exist")
	}
	if role == auth.RoleAdmin && !tenant.IsDistributor {
		return apperr.Invalid("body.role", "user.admin_requires_distributor", "admins must belong to the distributor tenant")
	}
	return nil
}

func hashPassword(ctx context.Context, location, pw string) (string, error) {
	if len([]rune(pw)) < password.MinLength {
		return "", apperr.Invalid(location, "user.password_too_short", "password is too short")
	}
	h, err := password.Hash(ctx, pw)
	return h, passwordErr(err)
}

// passwordErr turns a full hashing queue into 503 server.busy.
func passwordErr(err error) error {
	if errors.Is(err, password.ErrBusy) {
		return apperr.New(http.StatusServiceUnavailable, "server.busy", "server busy, try again shortly")
	}
	return err
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

// DisplayName returns what other features show for a user (a plan's lock
// holder): the full name, or the email when it is empty; "" for a user that
// no longer exists. Any logged-in caller may ask: the caller has already
// been shown a reference to the user (D193).
func (s *Service) DisplayName(ctx context.Context, id uuid.UUID) (string, error) {
	if _, err := auth.Require(ctx); err != nil {
		return "", err
	}
	row, err := s.q.GetUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if row.FullName != "" {
		return row.FullName, nil
	}
	return row.Email, nil
}
