-- name: ListCategories :many
SELECT * FROM categories
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetCategory :one
SELECT * FROM categories WHERE id = $1;

-- LockCategoryOrder serialises everything that assigns sort orders
-- (create, reorder) until the transaction ends.
-- name: LockCategoryOrder :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key)::bigint);

-- New categories go to the end of the order (under LockCategoryOrder, so two
-- creates never get the same sort order).
-- name: CreateCategory :one
INSERT INTO categories (key, name, description, is_active, attributes, instance_attributes, mounting, sort_order)
VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT coalesce(max(sort_order), 0) + 1 FROM categories))
RETURNING *;

-- UpdateCategory changes the category only if nobody else has since it was
-- read (expected_updated_at); no row means stale or deleted. updated_at
-- always moves forward, even for two updates within the same microsecond.
-- name: UpdateCategory :one
UPDATE categories
SET key = $2, name = $3, description = $4, is_active = $5, attributes = $6, instance_attributes = $7, mounting = $8,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: CategoryExists :one
SELECT EXISTS (SELECT 1 FROM categories WHERE id = $1);

-- name: DeleteCategory :execrows
DELETE FROM categories WHERE id = $1;

-- LockCategoryIDs locks every category row for a reorder, so none can
-- be deleted or reordered underneath it; new rows are kept out by
-- LockCategoryOrder, which the caller takes first.
-- name: LockCategoryIDs :many
SELECT id FROM categories ORDER BY id FOR UPDATE;

-- SetCategoryOrder gives the ids sort orders 1..n in the given order.
-- name: SetCategoryOrder :exec
UPDATE categories p SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE p.id = o.id;

-- FieldInUse reports whether any category attribute (product or instance)
-- links the catalog field key.
-- name: FieldInUse :one
SELECT EXISTS (
    SELECT 1 FROM categories c, jsonb_array_elements(c.attributes || c.instance_attributes) a
    WHERE a ->> 'fieldKey' = sqlc.arg(field_key)::text
);
