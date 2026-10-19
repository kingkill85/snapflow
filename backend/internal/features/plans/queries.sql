-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- name: ListPlans :many
SELECT p.*,
    (SELECT count(*) FROM plan_zones z WHERE z.plan_id = p.id) AS zone_count,
    (SELECT count(*) FROM plan_placements pp WHERE pp.plan_id = p.id) AS placement_count
FROM plans p
WHERE p.version_id = $1
ORDER BY p.position, p.id;

-- name: GetPlan :one
SELECT p.*,
    (SELECT count(*) FROM plan_zones z WHERE z.plan_id = p.id) AS zone_count,
    (SELECT count(*) FROM plan_placements pp WHERE pp.plan_id = p.id) AS placement_count
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
INSERT INTO plan_zones (tenant_id, plan_id, id, name, color, opacity, points, position)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(plan_id)::uuid, r.id, r.name, r.color, r.opacity, r.points, r.position
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (id uuid, name text, color text, opacity double precision, points jsonb, position integer);

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

-- CopyPlan copies a plan's row into another version (version copy): a new
-- id, the same image file, no lock.
-- name: CopyPlan :one
INSERT INTO plans (tenant_id, version_id, kind, name, position, image_file_id, image_width, image_height, scale)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(version_id)::uuid, kind, name, position, image_file_id, image_width,
    image_height, scale
FROM plans WHERE id = sqlc.arg(id)::uuid
RETURNING id;

-- name: PlanIDsForCopy :many
SELECT id FROM plans WHERE version_id = $1 ORDER BY position, id;

-- BOMPlans returns the plans of a version for the BOM (bom feature, through
-- BOMPlacements).
-- name: BOMPlans :many
SELECT id, name FROM plans WHERE version_id = $1 ORDER BY position, id;

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
