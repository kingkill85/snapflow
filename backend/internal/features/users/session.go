package users

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/users/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/password"
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
	AssignableRoles []auth.Role       `json:"assignableRoles" doc:"Roles the user may give to others"`
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
// token, which only the client keeps.
func (s *Service) Login(ctx context.Context, in LoginInput) (string, Me, error) {
	email := normalizeEmail(in.Email)
	if ok, wait := s.logins.Allow(email); !ok {
		return "", Me{}, apperr.New(http.StatusTooManyRequests, "auth.too_many_attempts", "too many login attempts").
			With("seconds", int(wait.Seconds())+1)
	}
	invalid := apperr.New(http.StatusUnauthorized, "auth.invalid_credentials", "invalid email or password")

	row, err := s.q.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		// Spend the same time as a real check so timing does not reveal accounts.
		_, _ = password.Verify(in.Password, dummyHash())
		return "", Me{}, invalid
	}
	if err != nil {
		return "", Me{}, err
	}
	ok, err := password.Verify(in.Password, row.PasswordHash)
	if err != nil {
		return "", Me{}, err
	}
	if !ok {
		return "", Me{}, invalid
	}
	tenant, err := s.tenants.Lookup(ctx, row.TenantID)
	if err != nil {
		return "", Me{}, err
	}
	if !row.IsActive || !tenant.IsActive {
		return "", Me{}, apperr.New(http.StatusForbidden, "auth.account_disabled", "account disabled")
	}
	s.logins.Reset(email)

	if err := s.q.DeleteExpiredSessions(ctx); err != nil {
		return "", Me{}, err
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
// every other session of the caller.
func (s *Service) ChangePassword(ctx context.Context, in PasswordInput) error {
	actor, err := auth.Require(ctx)
	if err != nil {
		return err
	}
	row, err := s.q.GetUser(ctx, actor.UserID)
	if err != nil {
		return mapErr(err, "")
	}
	ok, err := password.Verify(in.CurrentPassword, row.PasswordHash)
	if err != nil {
		return err
	}
	if !ok {
		return apperr.Invalid("body.currentPassword", "auth.wrong_password", "current password is wrong")
	}
	hash, err := hashPassword("body.newPassword", in.NewPassword)
	if err != nil {
		return err
	}
	return s.setPassword(ctx, actor.UserID, hash, &actor.SessionID)
}

// setPassword stores a new hash and ends the user's sessions except keep.
func (s *Service) setPassword(ctx context.Context, userID uuid.UUID, hash string, keep *uuid.UUID) error {
	if err := s.q.SetPasswordHash(ctx, store.SetPasswordHashParams{ID: userID, PasswordHash: hash}); err != nil {
		return err
	}
	return s.q.DeleteUserSessions(ctx, store.DeleteUserSessionsParams{UserID: userID, Keep: keep})
}

func (s *Service) me(ctx context.Context, actor auth.Actor, row store.User) (Me, error) {
	tenant, err := s.tenants.Lookup(ctx, row.TenantID)
	if err != nil {
		return Me{}, err
	}
	return toMe(actor, row, tenant.Name), nil
}

func toMe(actor auth.Actor, row store.User, tenantName string) Me {
	return Me{
		ID: row.ID, Email: row.Email, FullName: row.FullName, Role: row.Role,
		TenantID: row.TenantID, TenantName: tenantName,
		Permissions: row.Role.Permissions(), AssignableRoles: actor.AssignableRoles(),
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

var dummyHash = sync.OnceValue(func() string {
	h, _ := password.Hash("not a real password")
	return h
})

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
