-- Snapshots (version_items) ------------------------------------------------

-- name: ListItems :many
SELECT * FROM version_items WHERE version_id = $1 ORDER BY variant_id;

-- name: ItemVariantIDs :many
SELECT variant_id FROM version_items WHERE version_id = $1;

-- InsertItem takes a snapshot unless the version has one of the variant
-- (concurrent first appearances: the first one wins, never an update).
-- name: InsertItem :exec
INSERT INTO version_items (tenant_id, version_id, variant_id, product_id, product_name, variant_name, model_number, sku,
    product_type_id, product_type_key, product_type_name, product_type_abbreviation, product_type_color,
    product_type_position, category_id, category_name, category_position, unit_price, image_file_id, required_addon_ids)
VALUES (sqlc.arg(tenant_id), sqlc.arg(version_id), sqlc.arg(variant_id), sqlc.arg(product_id), sqlc.arg(product_name),
    sqlc.arg(variant_name), sqlc.arg(model_number), sqlc.narg(sku), sqlc.arg(product_type_id), sqlc.arg(product_type_key),
    sqlc.arg(product_type_name), sqlc.arg(product_type_abbreviation), sqlc.arg(product_type_color),
    sqlc.arg(product_type_position), sqlc.arg(category_id), sqlc.arg(category_name), sqlc.arg(category_position),
    sqlc.arg(unit_price), sqlc.narg(image_file_id), sqlc.arg(required_addon_ids))
ON CONFLICT (version_id, variant_id) DO NOTHING;

-- UpdateItem re-snapshots a variant ("Update from catalog").
-- name: UpdateItem :execrows
UPDATE version_items SET product_id = sqlc.arg(product_id), product_name = sqlc.arg(product_name),
    variant_name = sqlc.arg(variant_name), model_number = sqlc.arg(model_number), sku = sqlc.narg(sku),
    product_type_id = sqlc.arg(product_type_id), product_type_key = sqlc.arg(product_type_key),
    product_type_name = sqlc.arg(product_type_name), product_type_abbreviation = sqlc.arg(product_type_abbreviation),
    product_type_color = sqlc.arg(product_type_color), product_type_position = sqlc.arg(product_type_position),
    category_id = sqlc.arg(category_id), category_name = sqlc.arg(category_name),
    category_position = sqlc.arg(category_position), unit_price = sqlc.arg(unit_price),
    image_file_id = sqlc.narg(image_file_id), required_addon_ids = sqlc.arg(required_addon_ids), updated_at = now()
WHERE version_id = sqlc.arg(version_id) AND variant_id = sqlc.arg(variant_id);

-- name: CopyItems :exec
INSERT INTO version_items (tenant_id, version_id, variant_id, product_id, product_name, variant_name, model_number, sku,
    product_type_id, product_type_key, product_type_name, product_type_abbreviation, product_type_color,
    product_type_position, category_id, category_name, category_position, unit_price, image_file_id, required_addon_ids,
    captured_at, updated_at)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, variant_id, product_id, product_name, variant_name,
    model_number, sku, product_type_id, product_type_key, product_type_name, product_type_abbreviation,
    product_type_color, product_type_position, category_id, category_name, category_position, unit_price,
    image_file_id, required_addon_ids, captured_at, updated_at
FROM version_items WHERE version_id = sqlc.arg(source_id)::uuid;

-- Manual lines ---------------------------------------------------------------

-- name: ListManualLines :many
SELECT * FROM version_manual_lines WHERE version_id = $1 ORDER BY position, id;

-- name: GetManualLine :one
SELECT * FROM version_manual_lines WHERE id = $1;

-- name: LockManualLine :one
SELECT * FROM version_manual_lines WHERE id = $1 FOR UPDATE;

-- name: InsertManualLine :one
INSERT INTO version_manual_lines (tenant_id, version_id, position, variant_id, name, unit_price, quantity, note)
VALUES (sqlc.arg(tenant_id), sqlc.arg(version_id),
    (SELECT coalesce(max(position), 0) + 1 FROM version_manual_lines WHERE version_id = sqlc.arg(version_id)),
    sqlc.narg(variant_id), sqlc.narg(name), sqlc.narg(unit_price), sqlc.arg(quantity), sqlc.arg(note))
RETURNING *;

-- name: UpdateManualLine :one
UPDATE version_manual_lines SET variant_id = sqlc.narg(variant_id), name = sqlc.narg(name),
    unit_price = sqlc.narg(unit_price), quantity = sqlc.arg(quantity), note = sqlc.arg(note), updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteManualLine :execrows
DELETE FROM version_manual_lines WHERE id = $1;

-- name: SetManualLinePosition :exec
UPDATE version_manual_lines SET position = sqlc.arg(position) WHERE id = sqlc.arg(id);

-- name: CopyManualLines :exec
INSERT INTO version_manual_lines (tenant_id, version_id, position, variant_id, name, unit_price, quantity, note,
    created_at, updated_at)
SELECT sqlc.arg(tenant_id)::uuid, sqlc.arg(target_id)::uuid, position, variant_id, name, unit_price, quantity, note,
    created_at, updated_at
FROM version_manual_lines WHERE version_id = sqlc.arg(source_id)::uuid;

-- Pricing ------------------------------------------------------------------

-- name: GetPricing :one
SELECT * FROM version_pricing WHERE version_id = $1;

-- name: LockPricing :one
SELECT * FROM version_pricing WHERE version_id = $1 FOR UPDATE;

-- name: UpsertPricing :one
INSERT INTO version_pricing (version_id, tenant_id, discount_kind, discount_value, services_kind, services_value,
    services_label, intro_text, closing_text)
VALUES (sqlc.arg(version_id), sqlc.arg(tenant_id), sqlc.arg(discount_kind), sqlc.arg(discount_value),
    sqlc.arg(services_kind), sqlc.arg(services_value), sqlc.narg(services_label), sqlc.narg(intro_text),
    sqlc.narg(closing_text))
ON CONFLICT (version_id) DO UPDATE SET discount_kind = excluded.discount_kind,
    discount_value = excluded.discount_value, services_kind = excluded.services_kind,
    services_value = excluded.services_value, services_label = excluded.services_label,
    intro_text = excluded.intro_text, closing_text = excluded.closing_text, updated_at = now()
RETURNING *;

-- name: CopyPricing :exec
INSERT INTO version_pricing (version_id, tenant_id, discount_kind, discount_value, services_kind, services_value,
    services_label, intro_text, closing_text, updated_at)
SELECT sqlc.arg(target_id)::uuid, sqlc.arg(tenant_id)::uuid, discount_kind, discount_value, services_kind,
    services_value, services_label, intro_text, closing_text, updated_at
FROM version_pricing WHERE version_id = sqlc.arg(source_id)::uuid;

-- ReferencedFiles returns those of the files that rows reference (the
-- files feature's reference check, D269).
-- name: ReferencedFiles :many
SELECT DISTINCT image_file_id::uuid AS file_id FROM version_items WHERE image_file_id = ANY(sqlc.arg(ids)::uuid[]);
