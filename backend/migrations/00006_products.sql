-- +goose Up
-- Products are the orderable device models of the global catalog; variants
-- are their sellable versions (colour, finish) with a price; add-ons link a
-- variant to other variants that go with it. One aggregate (features/products).
CREATE TABLE products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- RESTRICT: a product type in use cannot be deleted (product_type.in_use).
    product_type_id uuid NOT NULL REFERENCES product_types (id) ON DELETE RESTRICT,
    -- The business key, e.g. 'M485/GW-ZB.10'; unique ignoring case.
    model_number    text NOT NULL CHECK (model_number <> '' AND model_number = btrim(model_number)),
    name            jsonb NOT NULL,
    description     jsonb,
    -- Product-scope attribute values (platform/attrschema), plus stale values
    -- whose key the type's schema no longer has.
    attributes      jsonb NOT NULL DEFAULT '{}',
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_model_number_key ON products (lower(model_number));
CREATE INDEX products_product_type_id_idx ON products (product_type_id);

CREATE TABLE product_variants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id    uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    -- Unique per product on the English name, ignoring case.
    name          jsonb NOT NULL,
    -- Optional; unique ignoring case when set.
    sku           text CHECK (sku <> '' AND sku = btrim(sku)),
    -- List price in the catalog base currency (USD).
    price         numeric(12, 2) NOT NULL CHECK (price >= 0),
    image_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    -- Variant-scope attribute values, plus stale values.
    attributes    jsonb NOT NULL DEFAULT '{}',
    sort_order    integer NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_variants_name_key ON product_variants (product_id, lower(name ->> 'en'));
CREATE UNIQUE INDEX product_variants_sku_key ON product_variants (lower(sku)) WHERE sku IS NOT NULL;
CREATE INDEX product_variants_image_file_id_idx ON product_variants (image_file_id);

CREATE TABLE variant_addons (
    variant_id       uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
    addon_variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
    -- Required add-ons are added to the BOM automatically (phase 2).
    required         boolean NOT NULL DEFAULT false,
    sort_order       integer NOT NULL,
    PRIMARY KEY (variant_id, addon_variant_id),
    CHECK (variant_id <> addon_variant_id)
);
CREATE INDEX variant_addons_addon_variant_id_idx ON variant_addons (addon_variant_id);

-- +goose Down
DROP TABLE variant_addons;
DROP TABLE product_variants;
DROP TABLE products;
