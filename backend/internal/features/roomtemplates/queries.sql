-- LockOrder serialises everything that assigns sort orders (create,
-- reorder) until the transaction ends.
-- name: LockOrder :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key)::bigint);

-- name: ListTemplates :many
SELECT * FROM room_templates
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetTemplate :one
SELECT * FROM room_templates WHERE id = $1;

-- name: CreateTemplate :one
INSERT INTO room_templates (key, name, equipment_level, is_active, sort_order)
VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM room_templates))
RETURNING *;

-- name: UpdateTemplate :one
UPDATE room_templates
SET key = $2, name = $3, equipment_level = $4, is_active = $5,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: TemplateExists :one
SELECT EXISTS (SELECT 1 FROM room_templates WHERE id = $1);

-- name: DeleteTemplate :execrows
DELETE FROM room_templates WHERE id = $1;

-- name: LockTemplateIDs :many
SELECT id FROM room_templates ORDER BY id FOR UPDATE;

-- name: SetTemplateOrder :exec
UPDATE room_templates t SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE t.id = o.id;

-- name: ListLines :many
SELECT * FROM room_template_lines
WHERE template_id = ANY(sqlc.arg(template_ids)::uuid[])
ORDER BY template_id, position;

-- name: DeleteLines :exec
DELETE FROM room_template_lines WHERE template_id = $1;

-- name: InsertLines :exec
INSERT INTO room_template_lines (template_id, position, function_type_id, quantity, power_w, load_type_id, label)
SELECT sqlc.arg(template_id)::uuid, r.position, r.function_type_id, r.quantity, r.power_w, r.load_type_id, r.label
FROM jsonb_to_recordset(sqlc.arg(rows)::jsonb)
    AS r (position integer, function_type_id uuid, quantity integer, power_w double precision, load_type_id uuid,
          label text);
