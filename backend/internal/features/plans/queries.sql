-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- name: ListPlans :many
SELECT p.*,
    (SELECT count(*) FROM plan_zones z WHERE z.plan_id = p.id) AS zone_count,
    (SELECT count(*) FROM plan_placements pp WHERE pp.plan_id = p.id) AS placement_count,
    (SELECT coalesce(sum(n.quantity), 0)::bigint FROM plan_needs n WHERE n.plan_id = p.id) AS need_count,
    (SELECT count(*) FROM board_modules m WHERE m.plan_id = p.id) AS module_count,
    (SELECT coalesce(sum(r.capacity_te), 0)::float8 FROM board_rows r WHERE r.plan_id = p.id) AS capacity_te
FROM plans p
WHERE p.version_id = $1
ORDER BY p.position, p.id;

-- name: GetPlan :one
SELECT p.*,
    (SELECT count(*) FROM plan_zones z WHERE z.plan_id = p.id) AS zone_count,
    (SELECT count(*) FROM plan_placements pp WHERE pp.plan_id = p.id) AS placement_count,
    (SELECT coalesce(sum(n.quantity), 0)::bigint FROM plan_needs n WHERE n.plan_id = p.id) AS need_count,
    (SELECT count(*) FROM board_modules m WHERE m.plan_id = p.id) AS module_count,
    (SELECT coalesce(sum(r.capacity_te), 0)::float8 FROM board_rows r WHERE r.plan_id = p.id) AS capacity_te
FROM plans p
WHERE p.id = $1;

-- LockPlan locks a plan for a change of it, its content or its edit lock
-- (after its project, WriteVersion).
-- name: LockPlan :one
SELECT * FROM plans WHERE id = $1 FOR UPDATE;

-- name: PlanVersion :one
SELECT version_id FROM plans WHERE id = $1;

-- CreatePlan adds a plan after the version's last one (the caller holds the
-- project's lock).
-- name: CreatePlan :one
INSERT INTO plans (tenant_id, version_id, name, position, image_file_id, image_width, image_height)
VALUES ($1, $2, $3, (SELECT coalesce(max(position), 0) + 1 FROM plans WHERE version_id = $2), $4, $5, $6)
RETURNING id;

-- name: UpdatePlan :exec
UPDATE plans SET name = $2, image_file_id = $3, image_width = $4, image_height = $5, updated_at = now()
WHERE id = $1;

-- TouchContent moves the content version on (strictly, also within one
-- clock tick) and sets the scale.
-- name: TouchContent :one
UPDATE plans SET scale = $2,
    content_updated_at = greatest(now(), content_updated_at + interval '1 microsecond')
WHERE id = $1
RETURNING content_updated_at;

-- name: DeletePlan :execrows
DELETE FROM plans WHERE id = $1;

-- name: PlanIDsOfVersion :many
SELECT id FROM plans WHERE version_id = $1 ORDER BY id FOR UPDATE;

-- SetPlanOrder sets the positions to the order of ids (1..n).
-- name: SetPlanOrder :exec
UPDATE plans SET position = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE plans.id = o.id;

-- name: SetLock :exec
UPDATE plans SET lock_user_id = $2, lock_expires_at = $3 WHERE id = $1;

-- name: ListZones :many
SELECT * FROM plan_zones WHERE plan_id = $1 ORDER BY position;

-- name: ListPlacements :many
SELECT * FROM plan_placements WHERE plan_id = $1 ORDER BY position;

-- name: DeleteZones :exec
DELETE FROM plan_zones WHERE plan_id = $1;

-- name: DeletePlacements :exec
DELETE FROM plan_placements WHERE plan_id = $1;

-- InsertZones inserts the zones of a JSON array (one statement for up to
-- 200 zones).
-- name: InsertZones :exec
INSERT INTO plan_zones (tenant_id, plan_id, id, name, short_name, color, opacity, points, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.name, coalesce(r."shortName", ''), r.color, r.opacity, r.points, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (id uuid, name text, "shortName" text, color text, opacity double precision, points jsonb, position integer);

-- InsertPlacements inserts the placements of a JSON array (one statement for
-- up to 2000 placements).
-- name: InsertPlacements :exec
INSERT INTO plan_placements (tenant_id, plan_id, id, variant_id, catalog_variant_id, x, y, width, height, rotation,
    label, existing, addon_variant_ids, instance_values, zone_id, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.variant_id, r.catalog_variant_id, r.x, r.y, r.width,
    r.height, r.rotation, r.label, r.existing, r.addon_variant_ids, r.instance_values, r.zone_id, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (id uuid, variant_id uuid, catalog_variant_id uuid, x double precision, y double precision, width double precision,
          height double precision, rotation double precision, label text, existing boolean,
          addon_variant_ids uuid[], instance_values jsonb, zone_id uuid, position integer);

-- name: ListNeeds :many
SELECT * FROM plan_needs WHERE plan_id = $1 ORDER BY position;

-- name: DeleteNeeds :exec
DELETE FROM plan_needs WHERE plan_id = $1;

-- InsertNeeds inserts the needs of a JSON array (one statement for up to
-- 2000 needs).
-- name: InsertNeeds :exec
INSERT INTO plan_needs (tenant_id, plan_id, id, function_type_id, quantity, power_w, load_type_id, label, note, x, y,
    zone_id, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.function_type_id, r.quantity, r.power_w,
    r.load_type_id, r.label, r.note, r.x, r.y, r.zone_id, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (id uuid, function_type_id uuid, quantity integer, power_w numeric, load_type_id uuid, label text,
          note text, x double precision, y double precision, zone_id uuid, position integer);

-- VersionNeeds returns the needs of a version's plans (the needs summary).
-- name: VersionNeeds :many
SELECT n.plan_id, n.id, n.function_type_id, n.quantity, n.power_w, n.load_type_id, n.label, n.note,
    (n.x IS NOT NULL)::boolean AS symbol, n.zone_id
FROM plan_needs n JOIN plans p ON p.id = n.plan_id
WHERE p.version_id = $1
ORDER BY n.plan_id, n.position;

-- CopyPlan copies a plan's row into another version (version copy): a new
-- id, the same image file, no lock.
-- name: CopyPlan :one
INSERT INTO plans (tenant_id, version_id, kind, name, position, image_file_id, image_width, image_height, scale,
    enclosure_variant_id, enclosure_catalog_variant_id)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(version_id)::uuid, kind, name, position, image_file_id, image_width,
    image_height, scale, enclosure_variant_id, enclosure_catalog_variant_id
FROM plans WHERE id = sqlc.arg(id)::uuid
RETURNING id;

-- name: PlanIDsForCopy :many
SELECT id FROM plans WHERE version_id = $1 ORDER BY position, id;

-- BOMPlans returns the plans of a version for the BOM (bom feature, through
-- BOMPlacements).
-- name: BOMPlans :many
SELECT id, name FROM plans WHERE version_id = $1 ORDER BY position, id;

-- name: BOMModules :many
SELECT m.plan_id, m.id, m.catalog_variant_id, (m.variant_id IS NULL)::boolean AS variant_deleted,
       m.existing, m.addon_variant_ids
FROM board_modules m JOIN plans p ON p.id = m.plan_id
WHERE p.version_id = $1
ORDER BY m.plan_id, m.position;

-- name: BOMEnclosures :many
SELECT id AS plan_id, enclosure_catalog_variant_id, (enclosure_variant_id IS NULL)::boolean AS variant_deleted,
       enclosure_existing
FROM plans
WHERE version_id = $1 AND enclosure_catalog_variant_id IS NOT NULL
ORDER BY position, id;

-- name: BOMZones :many
SELECT z.plan_id, z.id, z.name
FROM plan_zones z JOIN plans p ON p.id = z.plan_id
WHERE p.version_id = $1
ORDER BY z.plan_id, z.position;

-- name: BOMPlacements :many
SELECT pp.plan_id, pp.id, pp.catalog_variant_id, (pp.variant_id IS NULL)::boolean AS variant_deleted,
       pp.existing, pp.addon_variant_ids, pp.zone_id
FROM plan_placements pp JOIN plans p ON p.id = pp.plan_id
WHERE p.version_id = $1
ORDER BY pp.plan_id, pp.position;

-- ReferencedFiles returns those of the files that rows reference (the
-- files feature's reference check, D269).
-- name: ReferencedFiles :many
SELECT DISTINCT image_file_id::uuid AS file_id FROM plans WHERE image_file_id = ANY(sqlc.arg(ids)::uuid[]);


-- ---------------------------------------------------------------- boards

-- CreateBoard adds a board plan after the version's last plan (the caller
-- holds the project's lock).
-- name: CreateBoard :one
INSERT INTO plans (tenant_id, version_id, kind, name, position, enclosure_variant_id, enclosure_catalog_variant_id)
VALUES ($1, $2, 'board', $3, (SELECT coalesce(max(position), 0) + 1 FROM plans WHERE version_id = $2), $4, $4)
RETURNING id;

-- name: RenamePlan :exec
UPDATE plans SET name = $2, updated_at = now() WHERE id = $1;

-- name: SetEnclosure :exec
UPDATE plans SET enclosure_variant_id = $2, enclosure_catalog_variant_id = $3, enclosure_existing = $4 WHERE id = $1;

-- name: ListBoardRows :many
SELECT id, capacity_te::float8 AS capacity_te FROM board_rows WHERE plan_id = $1 ORDER BY position;

-- name: ListBoardModules :many
SELECT id, row_id, offset_te::float8 AS offset_te, variant_id, catalog_variant_id, label, existing,
    addon_variant_ids, instance_values
FROM board_modules WHERE plan_id = $1 ORDER BY position;

-- name: DeleteBoardModules :exec
DELETE FROM board_modules WHERE plan_id = $1;

-- name: DeleteBoardRows :exec
DELETE FROM board_rows WHERE plan_id = $1;

-- name: InsertBoardRows :exec
INSERT INTO board_rows (tenant_id, plan_id, id, capacity_te, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.capacity_te, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb) AS r (id uuid, capacity_te numeric, position integer);

-- name: InsertBoardModules :exec
INSERT INTO board_modules (tenant_id, plan_id, id, row_id, offset_te, variant_id, catalog_variant_id, label, existing,
    addon_variant_ids, instance_values, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.row_id, r.offset_te, r.variant_id,
    r.catalog_variant_id, r.label, r.existing, r.addon_variant_ids, r.instance_values, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (id uuid, row_id uuid, offset_te numeric, variant_id uuid, catalog_variant_id uuid, label text,
          existing boolean, addon_variant_ids uuid[], instance_values jsonb, position integer);

-- BoardSketchModules returns the modules of a version's boards with their
-- row's position (plan cards: TE used and the sketch).
-- name: BoardSketchModules :many
SELECT m.plan_id, m.variant_id, r.position AS row_position, m.offset_te::float8 AS offset_te, m.existing
FROM board_modules m JOIN plans p ON p.id = m.plan_id JOIN board_rows r ON r.plan_id = m.plan_id AND r.id = m.row_id
WHERE p.version_id = $1
ORDER BY m.plan_id, m.position;

-- name: BoardSketchRows :many
SELECT r.plan_id, r.capacity_te::float8 AS capacity_te
FROM board_rows r JOIN plans p ON p.id = r.plan_id
WHERE p.version_id = $1
ORDER BY r.plan_id, r.position;

-- PlanBoardSketchModules is BoardSketchModules of one board.
-- name: PlanBoardSketchModules :many
SELECT m.plan_id, m.variant_id, r.position AS row_position, m.offset_te::float8 AS offset_te, m.existing
FROM board_modules m JOIN board_rows r ON r.plan_id = m.plan_id AND r.id = m.row_id
WHERE m.plan_id = $1
ORDER BY m.position;

-- name: PlanBoardSketchRows :many
SELECT r.plan_id, r.capacity_te::float8 AS capacity_te
FROM board_rows r
WHERE r.plan_id = $1
ORDER BY r.position;

-- NetworkPlacements returns the placements of a version (networks
-- feature, through NetworkItems).
-- name: NetworkPlacements :many
SELECT pp.plan_id, pp.id, pp.variant_id, pp.label, pp.existing, pp.zone_id
FROM plan_placements pp JOIN plans p ON p.id = pp.plan_id
WHERE p.version_id = $1
ORDER BY pp.plan_id, pp.position;

-- name: NetworkModules :many
SELECT m.plan_id, m.id, m.variant_id, m.label, m.existing
FROM board_modules m JOIN plans p ON p.id = m.plan_id
WHERE p.version_id = $1
ORDER BY m.plan_id, m.position;

-- name: NetworkPlans :many
SELECT id, name, kind, position FROM plans WHERE version_id = $1 ORDER BY position, id;

-- What the wiring feature (step 3d: connections, checks) reads of a
-- version, through WiringData.
-- name: WiringPlans :many
SELECT id, name, kind, position FROM plans WHERE version_id = $1 ORDER BY position, id;

-- name: WiringZones :many
SELECT z.plan_id, z.id, z.name, z.short_name
FROM plan_zones z JOIN plans p ON p.id = z.plan_id
WHERE p.version_id = $1
ORDER BY z.plan_id, z.position;

-- name: WiringPlacements :many
SELECT pp.plan_id, pp.id, pp.variant_id, pp.zone_id, pp.label
FROM plan_placements pp JOIN plans p ON p.id = pp.plan_id
WHERE p.version_id = $1
ORDER BY pp.plan_id, pp.position;

-- name: WiringRows :many
SELECT r.plan_id, r.id, r.position, r.capacity_te::float8 AS capacity_te
FROM board_rows r JOIN plans p ON p.id = r.plan_id
WHERE p.version_id = $1
ORDER BY r.plan_id, r.position;

-- name: WiringModules :many
SELECT m.plan_id, m.id, m.row_id, m.offset_te::float8 AS offset_te, m.variant_id, m.label
FROM board_modules m JOIN plans p ON p.id = m.plan_id
WHERE p.version_id = $1
ORDER BY m.plan_id, m.position;

-- ZoneNames: every zone of a version's floorplans with its short name
-- (channel labels, 3e).
-- name: ZoneNames :many
SELECT z.plan_id, z.id, z.name, z.short_name
FROM plan_zones z JOIN plans p ON p.id = z.plan_id
WHERE p.version_id = $1
ORDER BY p.position, z.plan_id, z.position;
