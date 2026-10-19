-- name: ListTenants :many
SELECT * FROM tenants
WHERE sqlc.arg(include_archived)::boolean OR archived_at IS NULL
ORDER BY is_distributor DESC, lower(name);

-- name: GetTenant :one
SELECT * FROM tenants WHERE id = $1;

-- name: GetTenants :many
SELECT * FROM tenants WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: GetDistributor :one
SELECT * FROM tenants WHERE is_distributor;

-- name: CreateTenant :one
INSERT INTO tenants (name, is_distributor, is_active) VALUES ($1, $2, $3)
RETURNING *;

-- UpdateTenant changes a tenant; an archived one cannot be activated, also
-- when it was archived after the caller read it (no row then).
-- name: UpdateTenant :one
UPDATE tenants SET name = $2, is_active = $3, updated_at = now()
WHERE id = $1 AND (archived_at IS NULL OR NOT $3)
RETURNING *;

-- name: DeleteTenant :execrows
DELETE FROM tenants WHERE id = $1;

-- ArchiveTenant deactivates and archives a partner tenant (D13).
-- name: ArchiveTenant :one
UPDATE tenants SET is_active = false, archived_at = now(), updated_at = now()
WHERE id = $1 AND NOT is_distributor
RETURNING *;

-- RestoreTenant takes a tenant out of the archive; it stays inactive.
-- name: RestoreTenant :one
UPDATE tenants SET archived_at = NULL, updated_at = now()
WHERE id = $1 AND archived_at IS NOT NULL
RETURNING *;

-- name: UpdateLetterhead :one
UPDATE tenants SET company_name = $2, address = $3, phone = $4, email = $5, website = $6,
    logo_file_id = sqlc.narg(logo_file_id), updated_at = now()
WHERE id = $1
RETURNING *;
