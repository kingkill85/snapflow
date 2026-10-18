-- name: ListUsers :many
SELECT * FROM users
WHERE sqlc.narg(tenant_id)::uuid IS NULL OR tenant_id = sqlc.narg(tenant_id)
ORDER BY email;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserForUpdate :one
SELECT * FROM users WHERE id = $1 FOR UPDATE;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: CountActiveAdmins :one
SELECT count(*) FROM users WHERE role = 'admin' AND is_active;

-- LockActiveAdmins locks every active admin row, in a fixed order so that
-- concurrent callers queue instead of deadlocking.
-- name: LockActiveAdmins :many
SELECT id FROM users WHERE role = 'admin' AND is_active ORDER BY id FOR UPDATE;

-- name: CreateUser :one
INSERT INTO users (tenant_id, email, full_name, password_hash, role, is_active)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateUser :one
UPDATE users SET tenant_id = $2, email = $3, full_name = $4, role = $5, is_active = $6, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: PromoteToAdmin :one
UPDATE users SET tenant_id = $2, password_hash = $3, role = 'admin', is_active = true, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateProfile :one
UPDATE users SET email = $2, full_name = $3, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: SetPasswordHash :exec
UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1;

-- name: DeleteUser :execrows
DELETE FROM users WHERE id = $1;

-- name: CreateSession :one
INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
RETURNING *;

-- name: GetSessionByTokenHash :one
SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > now();

-- name: TouchSession :exec
UPDATE sessions SET last_used_at = now(), expires_at = $2 WHERE id = $1;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE id = $1;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = $1 AND (id <> sqlc.narg(keep)::uuid) IS NOT FALSE;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at <= now();
