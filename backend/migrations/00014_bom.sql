-- +goose Up
-- BOM and pricing (step 2c): price snapshots of the catalog variants a
-- version uses, manual BOM lines and the version's pricing settings.
-- Tenant-owned like plans (D12/D167): tenant_id follows the version through
-- the composite key, so a moved project carries them along.

CREATE TABLE version_items (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL,
    version_id                uuid NOT NULL,
    -- The catalog variant (frozen id, no foreign key: a deleted variant keeps
    -- its snapshot and its BOM lines, D59; the catalog status says deleted).
    variant_id                uuid NOT NULL,
    product_id                uuid NOT NULL,
    product_name              jsonb NOT NULL,
    variant_name              jsonb NOT NULL,
    model_number              text NOT NULL,
    sku                       text,
    product_type_id           uuid NOT NULL,
    product_type_key          text NOT NULL,
    product_type_name         jsonb NOT NULL,
    product_type_abbreviation text NOT NULL DEFAULT '',
    product_type_color        text NOT NULL DEFAULT '',
    product_type_position     integer NOT NULL,
    category_id               uuid NOT NULL,
    category_name             jsonb NOT NULL,
    category_position         integer NOT NULL,
    -- USD (D19).
    unit_price                numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
    image_file_id             uuid REFERENCES files (id) ON DELETE SET NULL,
    -- The variant's available required add-ons when the snapshot was taken.
    required_addon_ids        uuid[] NOT NULL DEFAULT '{}',
    captured_at               timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (version_id, variant_id),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX version_items_image_file_idx ON version_items (image_file_id);

CREATE TABLE version_manual_lines (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    version_id uuid NOT NULL,
    position   integer NOT NULL,
    -- Either a catalog line (variant_id, priced from its snapshot) or a
    -- free-text line (name and unit_price).
    variant_id uuid,
    name       text CHECK (name IS NULL OR (btrim(name) <> '' AND char_length(name) <= 200)),
    unit_price numeric(12, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
    quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
    note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((variant_id IS NOT NULL AND name IS NULL AND unit_price IS NULL)
        OR (variant_id IS NULL AND name IS NOT NULL AND unit_price IS NOT NULL)),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX version_manual_lines_version_idx ON version_manual_lines (version_id, position);

CREATE TABLE version_pricing (
    version_id     uuid PRIMARY KEY,
    tenant_id      uuid NOT NULL,
    discount_kind  text NOT NULL DEFAULT 'none' CHECK (discount_kind IN ('none', 'percent', 'amount')),
    discount_value numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
    services_kind  text NOT NULL DEFAULT 'none' CHECK (services_kind IN ('none', 'percent', 'amount')),
    services_value numeric(12, 2) NOT NULL DEFAULT 0 CHECK (services_value >= 0),
    -- NULL: the default label.
    services_label jsonb,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (discount_kind <> 'percent' OR discount_value <= 100),
    CHECK (services_kind <> 'percent' OR services_value <= 100),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- The catalog variant of a placement as last saved (plans, step 2c): kept
-- when the variant is deleted from the catalog (variant_id becomes NULL), so
-- the BOM still finds the placement's snapshot.
ALTER TABLE plan_placements ADD COLUMN catalog_variant_id uuid;
UPDATE plan_placements SET catalog_variant_id = variant_id;

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['version_items', 'version_manual_lines', 'version_pricing'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                   OR current_setting('app.access_all', true) = 'on')
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                   OR current_setting('app.access_all', true) = 'on')$p$, t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO snapflow_app', t);
    END LOOP;
END
$$;
-- +goose StatementEnd

-- +goose Down
ALTER TABLE plan_placements DROP COLUMN catalog_variant_id;
DROP TABLE version_pricing;
DROP TABLE version_manual_lines;
DROP TABLE version_items;
