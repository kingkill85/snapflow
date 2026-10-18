-- name: ListProductTypes :many
SELECT * FROM product_types
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetProductType :one
SELECT * FROM product_types WHERE id = $1;

-- LockProductTypeOrder serialises everything that assigns sort orders
-- (create, reorder) until the transaction ends.
-- name: LockProductTypeOrder :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key)::bigint);

-- New types go to the end of the order (under LockProductTypeOrder, so two
-- creates never get the same sort order).
-- name: CreateProductType :one
INSERT INTO product_types (key, name, description, color, is_active, attributes, instance_attributes, sort_order)
VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT coalesce(max(sort_order), 0) + 1 FROM product_types))
RETURNING *;

-- UpdateProductType changes the type only if nobody else has since it was
-- read (expected_updated_at); no row means stale or deleted. updated_at
-- always moves forward, even for two updates within the same microsecond.
-- name: UpdateProductType :one
UPDATE product_types
SET key = $2, name = $3, description = $4, color = $5, is_active = $6, attributes = $7, instance_attributes = $8,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: ProductTypeExists :one
SELECT EXISTS (SELECT 1 FROM product_types WHERE id = $1);

-- name: DeleteProductType :execrows
DELETE FROM product_types WHERE id = $1;

-- LockProductTypeIDs locks every product type row for a reorder, so none can
-- be deleted or reordered underneath it; new rows are kept out by
-- LockProductTypeOrder, which the caller takes first.
-- name: LockProductTypeIDs :many
SELECT id FROM product_types ORDER BY id FOR UPDATE;

-- SetProductTypeOrder gives the ids sort orders 1..n in the given order.
-- name: SetProductTypeOrder :exec
UPDATE product_types p SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE p.id = o.id;
