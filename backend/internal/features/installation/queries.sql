-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- NextSeq reserves the next sequence of a version and document kind.
-- name: NextSeq :one
INSERT INTO generated_document_counters (version_id, kind, tenant_id, last_seq)
VALUES (sqlc.arg(version_id), sqlc.arg(kind), sqlc.arg(tenant_id), 1)
ON CONFLICT (version_id, kind) DO UPDATE SET last_seq = generated_document_counters.last_seq + 1
RETURNING last_seq;

-- name: InsertDocument :one
INSERT INTO generated_documents (tenant_id, version_id, kind, seq, number, exporter, language, file_id, file_name, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: ListDocuments :many
SELECT * FROM generated_documents WHERE version_id = $1 ORDER BY created_at DESC, kind, seq DESC;

-- name: GetDocument :one
SELECT * FROM generated_documents WHERE id = $1;

-- name: DeleteDocument :execrows
DELETE FROM generated_documents WHERE id = $1;

-- name: ReferencedFiles :many
SELECT DISTINCT file_id::uuid AS file_id FROM generated_documents WHERE file_id = ANY(sqlc.arg(ids)::uuid[]);

-- name: FilesOfVersions :many
SELECT DISTINCT file_id FROM generated_documents WHERE version_id = ANY(sqlc.arg(version_ids)::uuid[]);

-- name: ListGroupAddressGroups :many
SELECT * FROM group_address_groups WHERE version_id = $1 ORDER BY main, middle;

-- name: ListGroupAddresses :many
SELECT * FROM group_addresses WHERE version_id = $1 ORDER BY main, middle, sub;

-- name: InsertGroupAddressGroup :exec
INSERT INTO group_address_groups (tenant_id, version_id, plan_id, zone_id, main, middle)
VALUES ($1, $2, $3, $4, $5, $6);

-- UpsertGroupAddress inserts a new group address or renames an existing one
-- (its number never changes).
-- name: UpsertGroupAddress :exec
INSERT INTO group_addresses (tenant_id, version_id, need_plan_id, need_id, object_key, main, middle, sub, name)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (version_id, need_plan_id, need_id, object_key) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
WHERE group_addresses.name <> EXCLUDED.name;

-- CopyGroupAddressGroups copies the groups of a version into another with
-- the plan ids mapped (a JSON object source id -> copy id); groups of
-- removed plans keep their plan id, so their numbers stay reserved.
-- name: CopyGroupAddressGroups :exec
INSERT INTO group_address_groups (tenant_id, version_id, plan_id, zone_id, main, middle)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, COALESCE((m.map ->> g.plan_id::text)::uuid, g.plan_id), g.zone_id, g.main, g.middle
FROM group_address_groups g, (SELECT sqlc.arg(plan_map)::jsonb AS map) m
WHERE g.version_id = sqlc.arg(source_id)::uuid;

-- CopyGroupAddresses: as CopyGroupAddressGroups.
-- name: CopyGroupAddresses :exec
INSERT INTO group_addresses (tenant_id, version_id, need_plan_id, need_id, object_key, main, middle, sub, name)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, COALESCE((m.map ->> a.need_plan_id::text)::uuid, a.need_plan_id), a.need_id,
    a.object_key, a.main, a.middle, a.sub, a.name
FROM group_addresses a, (SELECT sqlc.arg(plan_map)::jsonb AS map) m
WHERE a.version_id = sqlc.arg(source_id)::uuid;
