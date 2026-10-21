-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- name: ListBusLines :many
SELECT * FROM bus_lines WHERE version_id = $1 ORDER BY position, id;

-- name: GetBusLine :one
SELECT * FROM bus_lines WHERE version_id = $1 AND id = $2;

-- CreateBusLine adds a line after the version's last one (the caller holds
-- the project's lock).
-- name: CreateBusLine :one
INSERT INTO bus_lines (tenant_id, version_id, product_type_id, name, address, devices_max, position)
VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(position), 0) + 1 FROM bus_lines WHERE version_id = $2))
RETURNING *;

-- name: UpdateBusLine :one
UPDATE bus_lines SET name = $3, address = $4, devices_max = $5, updated_at = now()
WHERE version_id = $1 AND id = $2
RETURNING *;

-- name: DeleteBusLine :execrows
DELETE FROM bus_lines WHERE version_id = $1 AND id = $2;

-- ListLineAssignments returns the explicit assignments to a line (the
-- service counts those whose item is a current member of the line).
-- name: ListLineAssignments :many
SELECT * FROM network_assignments WHERE version_id = $1 AND bus_line_id = $2;

-- LockVersionLines serialises the default line creation of a version
-- (content saves of two plans of one version at once).
-- name: LockVersionLines :exec
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(version_id)::uuid::text, 3));

-- SetBusLineOrder sets the positions to the order of ids (1..n).
-- name: SetBusLineOrder :exec
UPDATE bus_lines SET position = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE bus_lines.version_id = sqlc.arg(version_id)::uuid AND bus_lines.id = o.id;

-- name: ListAssignments :many
SELECT * FROM network_assignments WHERE version_id = $1 ORDER BY plan_id, item_id;

-- name: UpsertAssignment :exec
INSERT INTO network_assignments (tenant_id, version_id, plan_id, item_id, bus_line_id, gateway_plan_id, gateway_item_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (plan_id, item_id) DO UPDATE SET bus_line_id = EXCLUDED.bus_line_id,
    gateway_plan_id = EXCLUDED.gateway_plan_id, gateway_item_id = EXCLUDED.gateway_item_id;

-- name: DeleteAssignment :exec
DELETE FROM network_assignments WHERE plan_id = $1 AND item_id = $2;

-- CopyBusLines copies the lines of a version into another, ids kept.
-- name: CopyBusLines :exec
INSERT INTO bus_lines (tenant_id, version_id, id, product_type_id, name, address, devices_max, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, id, product_type_id, name, address, devices_max, position
FROM bus_lines WHERE version_id = sqlc.arg(source_id)::uuid;

-- CopyAssignments copies the assignments of a version into another with
-- the plan ids mapped (a JSON object source id -> copy id).
-- name: CopyAssignments :exec
INSERT INTO network_assignments (tenant_id, version_id, plan_id, item_id, bus_line_id, gateway_plan_id, gateway_item_id)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, (m.map ->> a.plan_id::text)::uuid, a.item_id, a.bus_line_id,
    (m.map ->> a.gateway_plan_id::text)::uuid, a.gateway_item_id
FROM network_assignments a, (SELECT sqlc.arg(plan_map)::jsonb AS map) m
WHERE a.version_id = sqlc.arg(source_id)::uuid AND m.map ? a.plan_id::text
    AND (a.gateway_plan_id IS NULL OR m.map ? a.gateway_plan_id::text);

-- ---------------------------------------------------------------- addresses

-- name: ListAddresses :many
SELECT * FROM device_addresses WHERE version_id = $1 ORDER BY plan_id, item_id;

-- name: UpsertAddress :exec
INSERT INTO device_addresses (tenant_id, version_id, plan_id, item_id, knx_area, knx_line, knx_device, hdl_subnet, hdl_device, ieee, note, pinned)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (plan_id, item_id) DO UPDATE SET knx_area = EXCLUDED.knx_area, knx_line = EXCLUDED.knx_line,
    knx_device = EXCLUDED.knx_device, hdl_subnet = EXCLUDED.hdl_subnet, hdl_device = EXCLUDED.hdl_device,
    ieee = EXCLUDED.ieee, note = EXCLUDED.note, pinned = EXCLUDED.pinned, updated_at = now();

-- name: DeleteAddress :exec
DELETE FROM device_addresses WHERE version_id = $1 AND plan_id = $2 AND item_id = $3;

-- DeleteAutoAddresses removes the automatic rows without a note;
-- ClearAutoAddresses keeps the note of the others.
-- name: DeleteAutoAddresses :execrows
DELETE FROM device_addresses WHERE version_id = $1 AND NOT pinned AND note = '';

-- name: ClearAutoAddresses :execrows
UPDATE device_addresses SET knx_area = NULL, knx_line = NULL, knx_device = NULL, hdl_subnet = NULL, hdl_device = NULL,
    ieee = NULL, updated_at = now()
WHERE version_id = $1 AND NOT pinned AND (knx_device IS NOT NULL OR hdl_device IS NOT NULL OR ieee IS NOT NULL);

-- CopyAddresses copies the addresses of a version into another with the
-- plan ids mapped (a JSON object source id -> copy id).
-- name: CopyAddresses :exec
INSERT INTO device_addresses (tenant_id, version_id, plan_id, item_id, knx_area, knx_line, knx_device, hdl_subnet, hdl_device, ieee, note, pinned)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, (m.map ->> a.plan_id::text)::uuid, a.item_id, a.knx_area, a.knx_line,
    a.knx_device, a.hdl_subnet, a.hdl_device, a.ieee, a.note, a.pinned
FROM device_addresses a, (SELECT sqlc.arg(plan_map)::jsonb AS map) m
WHERE a.version_id = sqlc.arg(source_id)::uuid AND m.map ? a.plan_id::text;
