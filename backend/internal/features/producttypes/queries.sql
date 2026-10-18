-- name: ListProductTypes :many
SELECT * FROM product_types
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetProductType :one
SELECT * FROM product_types WHERE id = $1;

-- New types go to the end of the order.
-- name: CreateProductType :one
INSERT INTO product_types (key, name, description, is_active, attributes, instance_attributes, sort_order)
VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort_order), 0) + 1 FROM product_types))
RETURNING *;

-- name: UpdateProductType :one
UPDATE product_types
SET key = $2, name = $3, description = $4, is_active = $5, attributes = $6, instance_attributes = $7,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteProductType :execrows
DELETE FROM product_types WHERE id = $1;

-- LockProductTypeIDs locks every product type for a reorder, so the set of
-- ids cannot change underneath it.
-- name: LockProductTypeIDs :many
SELECT id FROM product_types ORDER BY id FOR UPDATE;

-- SetProductTypeOrder gives the ids sort orders 1..n in the given order.
-- name: SetProductTypeOrder :exec
UPDATE product_types p SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE p.id = o.id;
