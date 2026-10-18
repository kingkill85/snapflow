-- name: ListTenants :many
SELECT * FROM tenants ORDER BY is_distributor DESC, lower(name);

-- name: GetTenant :one
SELECT * FROM tenants WHERE id = $1;

-- name: GetDistributor :one
SELECT * FROM tenants WHERE is_distributor;

-- name: CreateTenant :one
INSERT INTO tenants (name, is_distributor, is_active) VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateTenant :one
UPDATE tenants SET name = $2, is_active = $3, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteTenant :execrows
DELETE FROM tenants WHERE id = $1;
