-- +goose Up
-- Catalog remodel (user decision replacing D14): a product type is now a
-- system or product line (Zigbee, KNX, HDL Buspro, ...) with an abbreviation
-- and a badge colour, and a category is the kind of device (Gateways, Dimmer
-- actuators, ...) that carries the attribute schemas. Every product has one
-- of each.
--
-- Existing data: every product type becomes a category with the same id, key,
-- name, description, schemas, catalog order and active flag, and every
-- product gets the category of its old product type. The product types keep
-- their old keys and names (only development data exists; nothing is in
-- production): an admin renames them to systems, or creates the systems and
-- moves the products. Works on an empty database too.
CREATE TABLE categories (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key                 text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    name                jsonb NOT NULL,
    description         jsonb,
    sort_order          integer NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    -- Attribute schemas (platform/attrschema): values on each product or
    -- variant, and per installed unit.
    attributes          jsonb NOT NULL DEFAULT '[]',
    instance_attributes jsonb NOT NULL DEFAULT '[]',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories (id, key, name, description, sort_order, is_active, attributes, instance_attributes, created_at, updated_at)
SELECT id, key, name, description, sort_order, is_active, attributes, instance_attributes, created_at, updated_at
FROM product_types;

ALTER TABLE products ADD COLUMN category_id uuid;
-- The categories above reuse the product type ids, so the mapping is 1:1.
UPDATE products SET category_id = product_type_id;
ALTER TABLE products
    ALTER COLUMN category_id SET NOT NULL,
    -- RESTRICT: a category in use cannot be deleted (category.in_use).
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT;
CREATE INDEX products_category_id_idx ON products (category_id);

ALTER TABLE product_types
    DROP COLUMN description,
    DROP COLUMN attributes,
    DROP COLUMN instance_attributes,
    -- Badge text, e.g. 'ZB'; upper case, at most 6 characters.
    ADD COLUMN abbreviation text CHECK (abbreviation <> '' AND char_length(abbreviation) <= 6);
-- Product types changed their meaning, so their updated_at moves: an editor
-- open on the old shape gets product_type.stale instead of saving it.
UPDATE product_types SET updated_at = greatest(now(), updated_at + interval '1 microsecond');

-- +goose Down
-- Best effort: the schemas and descriptions go back to the product type with
-- the category's id (the mapping the Up migration created); categories created
-- since are lost.
ALTER TABLE product_types
    DROP COLUMN abbreviation,
    ADD COLUMN description jsonb,
    ADD COLUMN attributes jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN instance_attributes jsonb NOT NULL DEFAULT '[]';
UPDATE product_types t
SET description = c.description, attributes = c.attributes, instance_attributes = c.instance_attributes
FROM categories c
WHERE c.id = t.id;
ALTER TABLE products DROP COLUMN category_id;
DROP TABLE categories;
