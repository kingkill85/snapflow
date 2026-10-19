-- name: ListConnections :many
SELECT * FROM connections WHERE version_id = $1 ORDER BY created_at, id;

-- name: GetConnection :one
SELECT * FROM connections WHERE version_id = $1 AND id = $2;

-- name: CreateConnection :one
INSERT INTO connections (tenant_id, version_id, need_plan_id, need_id, units, target_plan_id, target_item_id, output_kind_id,
    channel_no, alt_base_output_kind_id, alt_group, pinned, batch_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING *;

-- InsertConnections inserts the connections of a JSON array (an
-- auto-connect batch, one statement).
-- name: InsertConnections :exec
INSERT INTO connections (tenant_id, version_id, need_plan_id, need_id, units, target_plan_id, target_item_id, output_kind_id,
    channel_no, alt_base_output_kind_id, alt_group, pinned, batch_id, created_at)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(version_id)::uuid, r.need_plan_id, r.need_id, r.units, r.target_plan_id, r.target_item_id,
    r.output_kind_id, r.channel_no, r.alt_base_output_kind_id, r.alt_group, false, sqlc.arg(batch_id)::uuid,
    now() + (r.ord * interval '1 microsecond')
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb) AS r (need_plan_id uuid, need_id uuid, units integer, target_plan_id uuid,
    target_item_id uuid, output_kind_id uuid, channel_no integer, alt_base_output_kind_id uuid, alt_group integer, ord integer);

-- UpdateConnection moves a connection or changes its units; a change by hand
-- pins it and takes it out of its auto-connect batch.
-- name: UpdateConnection :one
UPDATE connections
SET units = $3, target_plan_id = $4, target_item_id = $5, output_kind_id = $6, channel_no = $7, alt_base_output_kind_id = $8,
    alt_group = $9, pinned = true, batch_id = NULL
WHERE version_id = $1 AND id = $2
RETURNING *;

-- name: DeleteConnection :execrows
DELETE FROM connections WHERE version_id = $1 AND id = $2;

-- name: DeleteNeedConnections :execrows
DELETE FROM connections WHERE version_id = $1 AND need_plan_id = $2 AND need_id = $3;

-- DeleteConnections removes connections by id (a channel's, resolved in
-- memory: alternative channels are identified by base kind and group, D410).
-- name: DeleteConnections :execrows
DELETE FROM connections WHERE version_id = $1 AND id = ANY(sqlc.arg(ids)::uuid[]);

-- DeleteBatch undoes an auto-connect run: only rows still from the batch
-- (a row changed by hand left it and is pinned).
-- name: DeleteBatch :execrows
DELETE FROM connections WHERE version_id = $1 AND batch_id = $2 AND NOT pinned;

-- CopyConnections copies the connections of a version into its copy, plan
-- ids mapped (D339); batches are not copied (undo stays in the source).
-- name: CopyConnections :exec
INSERT INTO connections (tenant_id, version_id, need_plan_id, need_id, units, target_plan_id, target_item_id, output_kind_id,
    channel_no, alt_base_output_kind_id, alt_group, pinned, batch_id, created_at)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid,
    (sqlc.arg(plan_map)::jsonb ->> c.need_plan_id::text)::uuid, c.need_id, c.units,
    (sqlc.arg(plan_map)::jsonb ->> c.target_plan_id::text)::uuid, c.target_item_id, c.output_kind_id, c.channel_no,
    c.alt_base_output_kind_id, c.alt_group, c.pinned, NULL, c.created_at
FROM connections c
WHERE c.version_id = sqlc.arg(source_id)::uuid;
