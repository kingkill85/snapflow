package users

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/users/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/password"
	"github.com/kingkill85/snapflow/backend/internal/platform/ratelimit"
)

// Me is the logged-in user with everything the client needs to adapt the UI.
type Me struct {
	ID              uuid.UUID         `json:"id"`
	Email           string            `json:"email"`
	FullName        string            `json:"fullName"`
	Role            auth.Role         `json:"role"`
	TenantID        uuid.UUID         `json:"tenantId"`
	TenantName      string            `json:"tenantName"`
	Permissions     []auth.Permission `json:"permissions" doc:"What the user may do, from the permission matrix"`
	AssignableRoles []auth.Role       `json:"assignableRoles" doc:"Roles the user may give to others; empty without users.manage"`
}

type LoginInput struct {
	Email    string `json:"email" maxLength:"254"`
	Password string `json:"password" maxLength:"200"`
}

type ProfileInput struct {
	Email    string `json:"email" format:"email" maxLength:"254"`
	FullName string `json:"fullName" maxLength:"200"`
}

type PasswordInput struct {
	CurrentPassword string `json:"currentPassword" maxLength:"200"`
	NewPassword     string `json:"newPassword" maxLength:"200"`
}

// renewAfter limits session writes: a session is extended at most this often.
const renewAfter = time.Hour

// Login checks the credentials and opens a session. It returns the session
// token, which only the client keeps. clientIP is the caller's address as
// determined by the HTTP layer.
//
// Only failed attempts count towards the limits, so a stranger who guesses
// at an account cannot lock its owner out: failures are limited per
// (email, client IP) pair, with looser caps per email and per client IP
// against distributed and spraying attacks. A successful login clears the
// pair.
func (s *Service) Login(ctx context.Context, in LoginInput, clientIP string) (string, Me, error) {
	email := normalizeEmail(in.Email)
	pairKey := email + "|" + clientIP
	var wait time.Duration
	for _, c := range []struct {
		l   *ratelimit.Limiter
		key string
	}{{s.loginPairFailures, pairKey}, {s.loginEmailFailures, email}, {s.loginIPFailures, clientIP}} {
		if ok, w := c.l.Check(c.key); !ok {
			wait = max(wait, w)
		}
	}
	if wait > 0 {
		return "", Me{}, apperr.TooManyRequests("auth.too_many_attempts", "too many login attempts", wait)
	}
	failed := func() (string, Me, error) {
		s.loginPairFailures.Add(pairKey)
		s.loginEmailFailures.Add(email)
		s.loginIPFailures.Add(clientIP)
		return "", Me{}, apperr.New(http.StatusUnauthorized, "auth.invalid_credentials", "invalid email or password")
	}

	row, err := s.q.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		// Spend the same time as a real check so timing does not reveal accounts.
		if _, err := password.Verify(ctx, in.Password, dummyHash); err != nil {
			return "", Me{}, passwordErr(err)
		}
		return failed()
	}
	if err != nil {
		return "", Me{}, err
	}
	ok, err := password.Verify(ctx, in.Password, row.PasswordHash)
	if err != nil {
		return "", Me{}, passwordErr(err)
	}
	if !ok {
		return failed()
	}
	s.loginPairFailures.Reset(pairKey)
	tenant, err := s.tenants.Lookup(ctx, row.TenantID)
	if err != nil {
		return "", Me{}, err
	}
	// Deliberate (as in v1): only with the right password, a disabled
	// account says so, so its user knows to contact their admin.
	if !row.IsActive || !tenant.IsActive {
		return "", Me{}, apperr.New(http.StatusForbidden, "auth.account_disabled", "account disabled")
	}

	// Housekeeping only: a failure must not prevent the login.
	if err := s.q.DeleteExpiredSessions(ctx); err != nil {
		slog.WarnContext(ctx, "login: delete expired sessions", "error", err)
	}
	token, err := newToken()
	if err != nil {
		return "", Me{}, err
	}
	if _, err := s.q.CreateSession(ctx, store.CreateSessionParams{
		TokenHash: hashToken(token), UserID: row.ID, ExpiresAt: time.Now().Add(auth.SessionTTL),
	}); err != nil {
		return "", Me{}, err
	}
	actor := auth.Actor{UserID: row.ID, TenantID: row.TenantID, Role: row.Role}
	return token, toMe(actor, row, tenant.Name), nil
}

// Authenticate resolves a session token to the actor. User and tenant are
// read on every request, so deactivation and role changes apply at once.
func (s *Service) Authenticate(ctx context.Context, token string) (auth.Actor, bool, error) {
	session, err := s.q.GetSessionByTokenHash(ctx, hashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Actor{}, false, auth.ErrInvalidSession
	}
	if err != nil {
		return auth.Actor{}, false, err
	}
	user, err := s.q.GetUser(ctx, session.UserID)
	if err != nil {
		return auth.Actor{}, false, err
	}
	tenant, err := s.tenants.Lookup(ctx, user.TenantID)
	if err != nil {
		return auth.Actor{}, false, err
	}
	if !user.IsActive || !tenant.IsActive {
		return auth.Actor{}, false, auth.ErrInvalidSession
	}
	renewed := false
	if time.Since(session.LastUsedAt) > renewAfter {
		if err := s.q.TouchSession(ctx, store.TouchSessionParams{ID: session.ID, ExpiresAt: time.Now().Add(auth.SessionTTL)}); err != nil {
			return auth.Actor{}, false, err
		}
		renewed = true
	}
	return auth.Actor{UserID: user.ID, TenantID: user.TenantID, SessionID: session.ID, Role: user.Role}, renewed, nil
}

// Logout ends the caller's current session.
func (s *Service) Logout(ctx context.Context) error {
	actor, err := auth.Require(ctx)
	if err != nil {
		return err
	}
	return s.q.DeleteSession(ctx, actor.SessionID)
}

// LogoutAll ends every session of the caller, the current one included
// ("sign out everywhere").
func (s *Service) LogoutAll(ctx context.Context) error {
	actor, err := auth.Require(ctx)
	if err != nil {
		return err
	}
	return s.q.DeleteUserSessions(ctx, store.DeleteUserSessionsParams{UserID: actor.UserID})
}

func (s *Service) Me(ctx context.Context) (Me, error) {
	actor, err := auth.Require(ctx)
	if err != nil {
		return Me{}, err
	}
	row, err := s.q.GetUser(ctx, actor.UserID)
	if err != nil {
		return Me{}, mapErr(err, "")
	}
	return s.me(ctx, actor, row)
}

// UpdateProfile changes the caller's own name and email.
func (s *Service) UpdateProfile(ctx context.Context, in ProfileInput) (Me, error) {
	actor, err := auth.Require(ctx)
	if err != nil {
		return Me{}, err
	}
	email := normalizeEmail(in.Email)
	row, err := s.q.UpdateProfile(ctx, store.UpdateProfileParams{
		ID: actor.UserID, Email: email, FullName: strings.TrimSpace(in.FullName),
	})
	if err != nil {
		return Me{}, mapErr(err, email)
	}
	return s.me(ctx, actor, row)
}

// ChangePassword sets a new password after checking the current one and ends
// every other session of the caller. Wrong current passwords are limited
// per user, so a hijacked session cannot be used to guess the password.
func (s *Service) ChangePassword(ctx context.Context, in PasswordInput) error {
	actor, err := auth.Require(ctx)
	if err != nil {
		return err
	}
	key := actor.UserID.String()
	if ok, wait := s.passwordFailures.Check(key); !ok {
		return apperr.TooManyRequests("auth.too_many_attempts", "too many wrong passwords", wait)
	}
	row, err := s.q.GetUser(ctx, actor.UserID)
	if err != nil {
		return mapErr(err, "")
	}
	ok, err := password.Verify(ctx, in.CurrentPassword, row.PasswordHash)
	if err != nil {
		return passwordErr(err)
	}
	if !ok {
		s.passwordFailures.Add(key)
		return apperr.Invalid("body.currentPassword", "auth.wrong_password", "current password is wrong")
	}
	hash, err := hashPassword(ctx, "body.newPassword", in.NewPassword)
	if err != nil {
		return err
	}
	s.passwordFailures.Reset(key)
	return s.inTx(ctx, func(q *store.Queries) error {
		return setPassword(ctx, q, actor.UserID, hash, &actor.SessionID)
	})
}

// setPassword stores a new hash and ends the user's sessions except keep.
// Call it inside a transaction.
func setPassword(ctx context.Context, q *store.Queries, userID uuid.UUID, hash string, keep *uuid.UUID) error {
	if err := q.SetPasswordHash(ctx, store.SetPasswordHashParams{ID: userID, PasswordHash: hash}); err != nil {
		return err
	}
	return q.DeleteUserSessions(ctx, store.DeleteUserSessionsParams{UserID: userID, Keep: keep})
}

func (s *Service) me(ctx context.Context, actor auth.Actor, row store.User) (Me, error) {
	tenant, err := s.tenants.Lookup(ctx, row.TenantID)
	if err != nil {
		return Me{}, err
	}
	return toMe(actor, row, tenant.Name), nil
}

func toMe(actor auth.Actor, row store.User, tenantName string) Me {
	assignable := []auth.Role{}
	if actor.Can(auth.PermUsersManage) {
		assignable = actor.AssignableRoles()
	}
	return Me{
		ID: row.ID, Email: row.Email, FullName: row.FullName, Role: row.Role,
		TenantID: row.TenantID, TenantName: tenantName,
		Permissions: row.Role.Permissions(), AssignableRoles: assignable,
	}
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// dummyHash is checked for unknown emails. It is a constant, so computing it
// can never fail (e.g. with password.ErrBusy); its parameters match Hash.
const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$l3UbfKSVZM8C/5c01VtcKA$aKKB6DSZmvJ0qe19K9l2BQa9K2niwiruWL9W2x77dvc"

// RoleMatrix is the permission matrix as data.
type RoleMatrix struct {
	Permissions []auth.Permission `json:"permissions" doc:"All permissions in display order"`
	Roles       []RolePermissions `json:"roles" doc:"All roles, highest first"`
}

type RolePermissions struct {
	Role        auth.Role         `json:"role"`
	Permissions []auth.Permission `json:"permissions"`
}

// Matrix returns the permission matrix to any logged-in user.
func (s *Service) Matrix(ctx context.Context) (RoleMatrix, error) {
	if _, err := auth.Require(ctx); err != nil {
		return RoleMatrix{}, err
	}
	out := RoleMatrix{Permissions: auth.Permissions}
	for _, r := range auth.Roles {
		out.Roles = append(out.Roles, RolePermissions{Role: r, Permissions: r.Permissions()})
	}
	return out, nil
}
