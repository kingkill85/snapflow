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
    customer_name, customer_company, customer_email, customer_phone, customer_address, notes, created_by,
    exchange_rate_date, exchange_rate_source, exchange_rate_provider)
VALUES ($1, $2, $3, 'active', $4, $5, sqlc.narg(exchange_rate), $6, $7, $8, $9, $10, $11, $12,
    sqlc.narg(exchange_rate_date), sqlc.narg(exchange_rate_source), sqlc.arg(exchange_rate_provider))
RETURNING *;

-- name: UpdateProject :one
UPDATE projects SET tenant_id = $2, number = $3, name = $4, status = $5, language = $6, currency = $7,
    exchange_rate = sqlc.narg(exchange_rate), customer_name = $8, customer_company = $9, customer_email = $10,
    customer_phone = $11, customer_address = $12, notes = $13, exchange_rate_date = sqlc.narg(exchange_rate_date),
    exchange_rate_source = sqlc.narg(exchange_rate_source), exchange_rate_provider = sqlc.arg(exchange_rate_provider),
    updated_at = now()
WHERE id = $1
RETURNING *;

-- SetExchangeRate stores a fetched or typed-in rate (refresh, set rate).
-- name: SetExchangeRate :one
UPDATE projects SET exchange_rate = sqlc.arg(exchange_rate), exchange_rate_date = sqlc.arg(exchange_rate_date),
    exchange_rate_source = sqlc.arg(exchange_rate_source), exchange_rate_provider = sqlc.arg(exchange_rate_provider),
    updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- RecentCurrencies are the currencies other than USD of a tenant's projects,
-- the most recently changed first.
-- name: RecentCurrencies :many
SELECT currency::text AS currency FROM projects
WHERE tenant_id = $1 AND currency <> 'USD'
GROUP BY currency
ORDER BY max(updated_at) DESC
LIMIT 5;

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

-- VersionAccess reads a version with what other features (plans) need of
-- its project. The Share and Lock variants lock the project row: FOR SHARE
-- orders content changes against status changes (which update the row),
-- FOR UPDATE also against each other and against version changes.
-- name: VersionAccess :one
SELECT v.id, v.project_id, p.tenant_id, p.status, p.currency, p.exchange_rate, p.exchange_rate_date, p.exchange_rate_source
FROM project_versions v JOIN projects p ON p.id = v.project_id
WHERE v.id = $1;

-- name: VersionAccessShare :one
SELECT v.id, v.project_id, p.tenant_id, p.status, p.currency, p.exchange_rate, p.exchange_rate_date, p.exchange_rate_source
FROM project_versions v JOIN projects p ON p.id = v.project_id
WHERE v.id = $1
FOR SHARE OF p;

-- name: VersionAccessLock :one
SELECT v.id, v.project_id, p.tenant_id, p.status, p.currency, p.exchange_rate, p.exchange_rate_date, p.exchange_rate_source
FROM project_versions v JOIN projects p ON p.id = v.project_id
WHERE v.id = $1
FOR UPDATE OF p;
