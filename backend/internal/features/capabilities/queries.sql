-- LockOrder serialises everything that assigns sort orders of one table
-- (create, reorder) until the transaction ends.
-- name: LockOrder :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key)::bigint);

-- ---------------------------------------------------------------- load types

-- name: ListLoadTypes :many
SELECT * FROM load_types
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetLoadType :one
SELECT * FROM load_types WHERE id = $1;

-- name: CreateLoadType :one
INSERT INTO load_types (key, name, is_active, power_factor, sort_order)
VALUES ($1, $2, $3, sqlc.arg(power_factor)::numeric, (SELECT coalesce(max(sort_order), 0) + 1 FROM load_types))
RETURNING *;

-- name: UpdateLoadType :one
UPDATE load_types
SET key = $2, name = $3, is_active = $4, power_factor = coalesce(sqlc.narg(power_factor)::numeric, power_factor),
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: LoadTypeExists :one
SELECT EXISTS (SELECT 1 FROM load_types WHERE id = $1);

-- name: DeleteLoadType :execrows
DELETE FROM load_types WHERE id = $1;

-- name: LockLoadTypeIDs :many
SELECT id FROM load_types ORDER BY id FOR UPDATE;

-- name: SetLoadTypeOrder :exec
UPDATE load_types t SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE t.id = o.id;

-- ---------------------------------------------------------------- output kinds

-- name: ListOutputKinds :many
SELECT * FROM output_kinds
WHERE is_active OR sqlc.arg(include_inactive)::boolean
ORDER BY sort_order, key;

-- name: GetOutputKind :one
SELECT * FROM output_kinds WHERE id = $1;

-- name: CreateOutputKind :one
INSERT INTO output_kinds (key, name, is_active, sort_order)
VALUES ($1, $2, $3, (SELECT coalesce(max(sort_order), 0) + 1 FROM output_kinds))
RETURNING *;

-- name: UpdateOutputKind :one
UPDATE output_kinds
SET key = $2, name = $3, is_active = $4,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: OutputKindExists :one
SELECT EXISTS (SELECT 1 FROM output_kinds WHERE id = $1);

-- name: DeleteOutputKind :execrows
DELETE FROM output_kinds WHERE id = $1;

-- name: LockOutputKindIDs :many
SELECT id FROM output_kinds ORDER BY id FOR UPDATE;

-- name: SetOutputKindOrder :exec
UPDATE output_kinds t SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE t.id = o.id;

-- name: ListOutputKindFunctionTypes :many
SELECT * FROM output_kind_function_types ORDER BY output_kind_id, function_type_id;

-- name: DeleteOutputKindFunctionTypes :exec
DELETE FROM output_kind_function_types WHERE output_kind_id = $1;

-- name: InsertOutputKindFunctionTypes :exec
INSERT INTO output_kind_function_types (output_kind_id, function_type_id)
SELECT sqlc.arg(output_kind_id)::uuid, unnest(sqlc.arg(function_type_ids)::uuid[]);

-- name: ListOutputKindAlternatives :many
SELECT * FROM output_kind_alternatives ORDER BY output_kind_id, from_kind_id;

-- name: DeleteOutputKindAlternatives :exec
DELETE FROM output_kind_alternatives WHERE output_kind_id = $1;

-- name: InsertOutputKindAlternative :exec
INSERT INTO output_kind_alternatives (output_kind_id, from_kind_id, count) VALUES ($1, $2, $3);

-- AlternativeCycle reports whether from_kind has kind as one of its
-- alternatives (a cycle of two).
-- name: AlternativeCycle :one
SELECT EXISTS (SELECT 1 FROM output_kind_alternatives WHERE output_kind_id = sqlc.arg(from_kind_id) AND from_kind_id = sqlc.arg(kind_id));

-- ---------------------------------------------------------------- catalog fields

-- name: ListCatalogFields :many
SELECT * FROM catalog_fields ORDER BY sort_order, key;

-- name: GetCatalogField :one
SELECT * FROM catalog_fields WHERE id = $1;

-- LockCatalogField locks a field against concurrent links (categories take
-- FOR SHARE on the fields they link, D305) before its key or type changes.
-- name: LockCatalogField :one
SELECT * FROM catalog_fields WHERE id = $1 FOR UPDATE;

-- ShareCatalogFields locks the linked fields of a category save: their type
-- cannot change until the save commits.
-- name: ShareCatalogFields :many
SELECT * FROM catalog_fields WHERE key = ANY(sqlc.arg(keys)::text[]) ORDER BY key FOR SHARE;

-- name: CreateCatalogField :one
INSERT INTO catalog_fields (key, label, value_type, unit, options, etim_feature, meaning, output_kind_id, load_type_id, sort_order)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT coalesce(max(sort_order), 0) + 1 FROM catalog_fields))
RETURNING *;

-- name: UpdateCatalogField :one
UPDATE catalog_fields
SET key = $2, label = $3, value_type = $4, unit = $5, options = $6, etim_feature = $7, meaning = $8,
    output_kind_id = $9, load_type_id = $10,
    updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: CatalogFieldExists :one
SELECT EXISTS (SELECT 1 FROM catalog_fields WHERE id = $1);

-- name: DeleteCatalogField :execrows
DELETE FROM catalog_fields WHERE id = $1;

-- name: LockCatalogFieldIDs :many
SELECT id FROM catalog_fields ORDER BY id FOR UPDATE;

-- name: SetCatalogFieldOrder :exec
UPDATE catalog_fields t SET sort_order = o.ord
FROM unnest(sqlc.arg(ids)::uuid[]) WITH ORDINALITY AS o (id, ord)
WHERE t.id = o.id;

-- name: ListCatalogFieldProductTypes :many
SELECT * FROM catalog_field_product_types ORDER BY catalog_field_id, product_type_id;

-- name: DeleteCatalogFieldProductTypes :exec
DELETE FROM catalog_field_product_types WHERE catalog_field_id = $1;

-- name: InsertCatalogFieldProductTypes :exec
INSERT INTO catalog_field_product_types (catalog_field_id, product_type_id)
SELECT sqlc.arg(catalog_field_id)::uuid, unnest(sqlc.arg(product_type_ids)::uuid[]);
