-- Products, variants and add-ons are one aggregate. Product type and category
-- facts (catalog order, active flags) come from producttypes.Service and
-- categories.Service and are passed in as arrays: this feature never reads
-- the product_types or categories tables.


-- name: GetProduct :one
SELECT * FROM products WHERE id = $1;

-- name: ProductExists :one
SELECT EXISTS (SELECT 1 FROM products WHERE id = $1);

-- LockProduct serialises changes to a product's variant list (sort orders).
-- Lock order of the aggregate: the product row first, then its variants.
-- name: LockProduct :one
SELECT id FROM products WHERE id = $1 FOR UPDATE;

-- ShareProduct keeps a product from being deleted, and waits for a running
-- variant reorder or create (LockProduct), before ReplaceAddons locks any
-- variant: the same order (product, then variants) as LockProduct callers.
-- name: ShareProduct :one
SELECT id FROM products WHERE id = $1 FOR KEY SHARE;

-- name: CreateProduct :one
INSERT INTO products (product_type_id, category_id, model_number, name, description, attributes, is_active)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- UpdateProduct changes the product only if nobody else has since it was
-- read (expected_updated_at); no row means stale or deleted.
-- name: UpdateProduct :one
UPDATE products
SET product_type_id = $2, category_id = $3, model_number = $4, name = $5, description = $6, attributes = $7, is_active = $8,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: DeleteProduct :execrows
DELETE FROM products WHERE id = $1;

-- ListProducts is one page of the product list in catalog order: product
-- type order (type_ids, in order), category order (category_ids, in order),
-- then model number. search is an ILIKE pattern ('' for none) over model
-- number, English and German name and description and the variants' SKUs.
-- Without include_inactive only active products of active types and active
-- categories are listed.
-- name: ListProducts :many
SELECT p.*
FROM products p
LEFT JOIN unnest(sqlc.arg(type_ids)::uuid[]) WITH ORDINALITY AS t (id, ord) ON t.id = p.product_type_id
LEFT JOIN unnest(sqlc.arg(category_ids)::uuid[]) WITH ORDINALITY AS c (id, ord) ON c.id = p.category_id
WHERE (sqlc.narg(product_type_id)::uuid IS NULL OR p.product_type_id = sqlc.narg(product_type_id))
  AND (sqlc.narg(category_id)::uuid IS NULL OR p.category_id = sqlc.narg(category_id))
  AND (sqlc.arg(include_inactive)::boolean
       OR (p.is_active AND NOT p.product_type_id = ANY (sqlc.arg(inactive_type_ids)::uuid[])
           AND NOT p.category_id = ANY (sqlc.arg(inactive_category_ids)::uuid[])))
  AND (sqlc.arg(search)::text = ''
       OR p.model_number ILIKE sqlc.arg(search)
       OR p.name ->> 'en' ILIKE sqlc.arg(search)
       OR p.name ->> 'de' ILIKE sqlc.arg(search)
       OR p.description ->> 'en' ILIKE sqlc.arg(search)
       OR p.description ->> 'de' ILIKE sqlc.arg(search)
       OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku ILIKE sqlc.arg(search)))
ORDER BY t.ord NULLS LAST, c.ord NULLS LAST, lower(p.model_number), p.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- CountProducts counts what ListProducts lists without the page.
-- name: CountProducts :one
SELECT count(*)
FROM products p
WHERE (sqlc.narg(product_type_id)::uuid IS NULL OR p.product_type_id = sqlc.narg(product_type_id))
  AND (sqlc.narg(category_id)::uuid IS NULL OR p.category_id = sqlc.narg(category_id))
  AND (sqlc.arg(include_inactive)::boolean
       OR (p.is_active AND NOT p.product_type_id = ANY (sqlc.arg(inactive_type_ids)::uuid[])
           AND NOT p.category_id = ANY (sqlc.arg(inactive_category_ids)::uuid[])))
  AND (sqlc.arg(search)::text = ''
       OR p.model_number ILIKE sqlc.arg(search)
       OR p.name ->> 'en' ILIKE sqlc.arg(search)
       OR p.name ->> 'de' ILIKE sqlc.arg(search)
       OR p.description ->> 'en' ILIKE sqlc.arg(search)
       OR p.description ->> 'de' ILIKE sqlc.arg(search)
       OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku ILIKE sqlc.arg(search)));


-- name: ListVariants :many
SELECT * FROM product_variants WHERE product_id = $1 ORDER BY sort_order, id;

-- name: ListVariantsOfProducts :many
SELECT * FROM product_variants WHERE product_id = ANY (sqlc.arg(product_ids)::uuid[])
ORDER BY product_id, sort_order, id;

-- name: GetVariant :one
SELECT * FROM product_variants WHERE id = $1 AND product_id = $2;

-- name: VariantExists :one
SELECT EXISTS (SELECT 1 FROM product_variants WHERE id = $1 AND product_id = $2);

-- New variants go to the end of their product's order (the caller holds
-- LockProduct, so two creates never get the same sort order).
-- name: CreateVariant :one
INSERT INTO product_variants (product_id, name, sku, price, image_file_id, attributes, is_active, sort_order)
VALUES ($1, $2, $3, sqlc.arg(price)::numeric, $4, $5, $6,
        (SELECT coalesce(max(sort_order), 0) + 1 FROM product_variants WHERE product_id = $1))
RETURNING *;

-- name: UpdateVariant :one
UPDATE product_variants
SET name = $3, sku = $4, price = sqlc.arg(price)::numeric, image_file_id = $5, attributes = $6, is_active = $7,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND product_id = $2 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: DeleteVariant :execrows
DELETE FROM product_variants WHERE id = $1 AND product_id = $2;

-- LockVariantIDs locks a product's variants for a reorder (after
-- LockProduct). NO KEY UPDATE keeps them from being deleted or updated
-- meanwhile but, unlike FOR UPDATE, does not wait for the KEY SHARE locks
-- that add-on replaces and add-on inserts take on them.
-- name: LockVariantIDs :many
SELECT id FROM product_variants WHERE product_id = $1 ORDER BY id FOR NO KEY UPDATE;

-- SetVariantOrder gives the ids sort orders 1..n in the given order.
-- name: SetVariantOrder :exec
UPDATE product_variants v SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE v.id = o.id;

-- SearchVariants is the add-on picker's list across the catalog, in catalog
-- order (product type order, category order, model number, variant order):
-- all variants without a search, else those whose product (as in
-- ListProducts) or own name or SKU matches. product_type_id and category_id
-- narrow it to one type or category.
-- name: SearchVariants :many
SELECT v.id, v.product_id, v.name, v.sku, v.price, v.image_file_id, v.is_active,
       p.model_number, p.name AS product_name, p.is_active AS product_is_active, p.product_type_id, p.category_id
FROM product_variants v
JOIN products p ON p.id = v.product_id
LEFT JOIN unnest(sqlc.arg(type_ids)::uuid[]) WITH ORDINALITY AS t (id, ord) ON t.id = p.product_type_id
LEFT JOIN unnest(sqlc.arg(category_ids)::uuid[]) WITH ORDINALITY AS c (id, ord) ON c.id = p.category_id
WHERE (sqlc.narg(product_type_id)::uuid IS NULL OR p.product_type_id = sqlc.narg(product_type_id))
  AND (sqlc.narg(category_id)::uuid IS NULL OR p.category_id = sqlc.narg(category_id))
  AND (sqlc.arg(search)::text = ''
       OR p.model_number ILIKE sqlc.arg(search)
       OR p.name ->> 'en' ILIKE sqlc.arg(search)
       OR p.name ->> 'de' ILIKE sqlc.arg(search)
       OR p.description ->> 'en' ILIKE sqlc.arg(search)
       OR p.description ->> 'de' ILIKE sqlc.arg(search)
       OR v.name ->> 'en' ILIKE sqlc.arg(search)
       OR v.name ->> 'de' ILIKE sqlc.arg(search)
       OR v.sku ILIKE sqlc.arg(search))
ORDER BY t.ord NULLS LAST, c.ord NULLS LAST, lower(p.model_number), p.id, v.sort_order, v.id
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- CountVariants counts what SearchVariants lists without the page.
-- name: CountVariants :one
SELECT count(*)
FROM product_variants v
JOIN products p ON p.id = v.product_id
WHERE (sqlc.narg(product_type_id)::uuid IS NULL OR p.product_type_id = sqlc.narg(product_type_id))
  AND (sqlc.narg(category_id)::uuid IS NULL OR p.category_id = sqlc.narg(category_id))
  AND (sqlc.arg(search)::text = ''
       OR p.model_number ILIKE sqlc.arg(search)
       OR p.name ->> 'en' ILIKE sqlc.arg(search)
       OR p.name ->> 'de' ILIKE sqlc.arg(search)
       OR p.description ->> 'en' ILIKE sqlc.arg(search)
       OR p.description ->> 'de' ILIKE sqlc.arg(search)
       OR v.name ->> 'en' ILIKE sqlc.arg(search)
       OR v.name ->> 'de' ILIKE sqlc.arg(search)
       OR v.sku ILIKE sqlc.arg(search));


-- LockVariantForAddons serialises add-on replaces of one variant (after
-- ShareProduct). NO KEY UPDATE does not conflict with the KEY SHARE locks
-- other replaces take on their add-on variants, so replaces of two variants
-- that point at each other do not wait for each other. Deadlocks with
-- deletes (which lock the add-on variants FOR UPDATE in their own order)
-- remain possible; inTx retries those.
-- name: LockVariantForAddons :one
SELECT id FROM product_variants WHERE id = $1 AND product_id = $2 FOR NO KEY UPDATE;

-- ExistingVariantIDs returns which of ids exist and keeps them from being
-- deleted until the transaction ends.
-- name: ExistingVariantIDs :many
SELECT id FROM product_variants WHERE id = ANY (sqlc.arg(ids)::uuid[]) ORDER BY id FOR KEY SHARE;

-- name: DeleteAddons :exec
DELETE FROM variant_addons WHERE variant_id = $1;

-- InsertAddons links the add-ons in list order (sort order 1..n).
-- name: InsertAddons :exec
INSERT INTO variant_addons (variant_id, addon_variant_id, required, sort_order)
SELECT sqlc.arg(variant_id)::uuid, (sqlc.arg(addon_ids)::uuid[])[i], (sqlc.arg(required)::boolean[])[i], i
FROM generate_subscripts(sqlc.arg(addon_ids)::uuid[], 1) AS i;

-- ListAddons returns the add-ons of the given variants with what the editor
-- shows of each add-on variant and its product.
-- name: ListAddons :many
SELECT a.variant_id, a.addon_variant_id, a.required, a.sort_order,
       v.name AS variant_name, v.price, v.image_file_id, v.is_active,
       p.id AS product_id, p.model_number, p.name AS product_name, p.is_active AS product_is_active, p.product_type_id,
       p.category_id
FROM variant_addons a
JOIN product_variants v ON v.id = a.addon_variant_id
JOIN products p ON p.id = v.product_id
WHERE a.variant_id = ANY (sqlc.arg(variant_ids)::uuid[])
ORDER BY a.variant_id, a.sort_order;
