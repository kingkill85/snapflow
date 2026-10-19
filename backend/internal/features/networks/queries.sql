-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- name: ListBusLines :many
SELECT * FROM bus_lines WHERE version_id = $1 ORDER BY position, id;

-- name: GetBusLine :one
SELECT * FROM bus_lines WHERE version_id = $1 AND id = $2;

-- CreateBusLine adds a line after the version's last one (the caller holds
-- the project's lock).
-- name: CreateBusLine :one
INSERT INTO bus_lines (tenant_id, version_id, product_type_id, name, address, position)
VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position), 0) + 1 FROM bus_lines WHERE version_id = $2))
RETURNING *;

-- name: UpdateBusLine :one
UPDATE bus_lines SET name = $3, address = $4, updated_at = now()
WHERE version_id = $1 AND id = $2
RETURNING *;

-- name: DeleteBusLine :execrows
DELETE FROM bus_lines WHERE version_id = $1 AND id = $2;

-- name: BusLineAssignmentCount :one
SELECT count(*) FROM network_assignments WHERE version_id = $1 AND bus_line_id = $2;

-- SetBusLineOrder sets the positions to the order of ids (1..n).
-- name: SetBusLineOrder :exec
UPDATE bus_lines SET position = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE bus_lines.version_id = sqlc.arg(version_id)::uuid AND bus_lines.id = o.id;

-- name: ListAssignments :many
SELECT * FROM network_assignments WHERE version_id = $1 ORDER BY plan_id, item_id;

-- name: UpsertAssignment :exec
INSERT INTO network_assignments (tenant_id, version_id, plan_id, item_id, bus_line_id, gateway_plan_id, gateway_item_id, pinned)
VALUES ($1, $2, $3, $4, $5, $6, $7, true)
ON CONFLICT (plan_id, item_id) DO UPDATE SET bus_line_id = EXCLUDED.bus_line_id,
    gateway_plan_id = EXCLUDED.gateway_plan_id, gateway_item_id = EXCLUDED.gateway_item_id, pinned = true;

-- name: DeleteAssignment :exec
DELETE FROM network_assignments WHERE plan_id = $1 AND item_id = $2;

-- CopyBusLines copies the lines of a version into another, ids kept.
-- name: CopyBusLines :exec
INSERT INTO bus_lines (tenant_id, version_id, id, product_type_id, name, address, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, id, product_type_id, name, address, position
FROM bus_lines WHERE version_id = sqlc.arg(source_id)::uuid;

-- CopyAssignments copies the assignments of a version into another with
-- the plan ids mapped (a JSON object source id -> copy id).
-- name: CopyAssignments :exec
INSERT INTO network_assignments (tenant_id, version_id, plan_id, item_id, bus_line_id, gateway_plan_id, gateway_item_id, pinned)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, (m.map ->> a.plan_id::text)::uuid, a.item_id, a.bus_line_id,
    (m.map ->> a.gateway_plan_id::text)::uuid, a.gateway_item_id, a.pinned
FROM network_assignments a, (SELECT sqlc.arg(plan_map)::jsonb AS map) m
WHERE a.version_id = sqlc.arg(source_id)::uuid AND m.map ? a.plan_id::text
    AND (a.gateway_plan_id IS NULL OR m.map ? a.gateway_plan_id::text);
