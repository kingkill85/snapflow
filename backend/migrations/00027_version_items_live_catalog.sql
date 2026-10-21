-- +goose Up
-- Badge, colour and order of a BOM follow the catalog (D456): version items
-- keep ids, keys and the frozen names only.
ALTER TABLE version_items
    DROP COLUMN product_type_abbreviation,
    DROP COLUMN product_type_color,
    DROP COLUMN product_type_position,
    DROP COLUMN category_position;

-- +goose Down
-- Best effort: the values the catalog has now (0 for a deleted type or
-- category).
ALTER TABLE version_items
    ADD COLUMN product_type_abbreviation text NOT NULL DEFAULT '',
    ADD COLUMN product_type_color        text NOT NULL DEFAULT '',
    ADD COLUMN product_type_position     integer NOT NULL DEFAULT 0,
    ADD COLUMN category_position         integer NOT NULL DEFAULT 0;
UPDATE version_items v SET product_type_abbreviation = coalesce(t.abbreviation, ''),
    product_type_color = coalesce(t.color, ''), product_type_position = t.sort_order
FROM product_types t WHERE t.id = v.product_type_id;
UPDATE version_items v SET category_position = c.sort_order
FROM categories c WHERE c.id = v.category_id;
ALTER TABLE version_items
    ALTER COLUMN product_type_position DROP DEFAULT,
    ALTER COLUMN category_position DROP DEFAULT;
