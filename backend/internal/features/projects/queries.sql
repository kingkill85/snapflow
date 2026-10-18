-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- NextProjectNumber counts up the tenant's project numbers of a year under
-- the counter row's lock, so parallel creates get distinct numbers.
-- name: NextProjectNumber :one
INSERT INTO project_number_counters (tenant_id, year, last_number) VALUES ($1, $2, 1)
ON CONFLICT (tenant_id, year) DO UPDATE SET last_number = project_number_counters.last_number + 1
RETURNING last_number;

-- ListProjects is one page of the project list, newest change first. search
-- is an ILIKE pattern ('' for none) over number, name and customer name and
-- company; status '' lists every status.
-- name: ListProjects :many
SELECT p.*, (SELECT count(*) FROM project_versions v WHERE v.project_id = p.id) AS version_count
FROM projects p
WHERE (sqlc.narg(tenant_id)::uuid IS NULL OR p.tenant_id = sqlc.narg(tenant_id))
  AND (sqlc.arg(status)::text = '' OR p.status = sqlc.arg(status))
  AND (sqlc.arg(search)::text = ''
       OR p.number ILIKE sqlc.arg(search)
       OR p.name ILIKE sqlc.arg(search)
       OR p.customer_name ILIKE sqlc.arg(search)
       OR p.customer_company ILIKE sqlc.arg(search))
ORDER BY p.updated_at DESC, p.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- CountProjects counts what ListProjects lists without the page.
-- name: CountProjects :one
SELECT count(*)
FROM projects p
WHERE (sqlc.narg(tenant_id)::uuid IS NULL OR p.tenant_id = sqlc.narg(tenant_id))
  AND (sqlc.arg(status)::text = '' OR p.status = sqlc.arg(status))
  AND (sqlc.arg(search)::text = ''
       OR p.number ILIKE sqlc.arg(search)
       OR p.name ILIKE sqlc.arg(search)
       OR p.customer_name ILIKE sqlc.arg(search)
       OR p.customer_company ILIKE sqlc.arg(search));

-- name: CountProjectsByTenant :many
SELECT tenant_id, count(*) AS project_count FROM projects
WHERE tenant_id = ANY (sqlc.arg(tenant_ids)::uuid[])
GROUP BY tenant_id;

-- name: GetProject :one
SELECT * FROM projects WHERE id = $1;

-- LockProject locks a project for a change of it or its versions.
-- name: LockProject :one
SELECT * FROM projects WHERE id = $1 FOR UPDATE;

-- name: CreateProject :one
INSERT INTO projects (tenant_id, number, name, status, language, currency, exchange_rate,
    customer_name, customer_company, customer_email, customer_phone, customer_address, notes, created_by)
VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING *;

-- name: UpdateProject :one
UPDATE projects SET tenant_id = $2, number = $3, name = $4, status = $5, language = $6, currency = $7,
    exchange_rate = $8, customer_name = $9, customer_company = $10, customer_email = $11,
    customer_phone = $12, customer_address = $13, notes = $14, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteProject :execrows
DELETE FROM projects WHERE id = $1;

-- name: ListProductTypesOfProjects :many
SELECT project_id, product_type_id FROM project_product_types
WHERE project_id = ANY (sqlc.arg(project_ids)::uuid[]);

-- name: DeleteProductTypesOfProject :exec
DELETE FROM project_product_types WHERE project_id = $1;

-- name: AddProductTypesToProject :exec
INSERT INTO project_product_types (tenant_id, project_id, product_type_id)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(project_id)::uuid, unnest(sqlc.arg(product_type_ids)::uuid[]);

-- name: ListVersions :many
SELECT * FROM project_versions WHERE project_id = $1 ORDER BY position;

-- name: GetVersion :one
SELECT * FROM project_versions WHERE id = $1 AND project_id = $2;

-- name: CountVersions :one
SELECT count(*) FROM project_versions WHERE project_id = $1;

-- CreateVersion adds a version after the project's last one (position is
-- the creation order; the caller holds the project's lock).
-- name: CreateVersion :one
INSERT INTO project_versions (tenant_id, project_id, name, notes, position)
VALUES ($1, $2, $3, $4,
    (SELECT coalesce(max(position), 0) + 1 FROM project_versions WHERE project_id = $2))
RETURNING *;

-- name: UpdateVersion :one
UPDATE project_versions SET name = $3, notes = $4, updated_at = now()
WHERE id = $1 AND project_id = $2
RETURNING *;

-- name: DeleteVersion :execrows
DELETE FROM project_versions WHERE id = $1 AND project_id = $2;
