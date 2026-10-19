-- +goose Up
-- Step 3c, distribution boards (D185, D355-): board plans with rows of DIN
-- rail and modules on them, bus lines and the explicit network assignments
-- of a version. Tenant-owned like plans (composite tenant keys, RLS). Row,
-- module and bus line ids are kept across saves and version copies (D339).

-- Board plans have no image (D195's image fields are for floorplans).
ALTER TABLE plans DROP CONSTRAINT plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('floorplan', 'board'));
ALTER TABLE plans ALTER COLUMN image_file_id DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN image_width DROP NOT NULL;
ALTER TABLE plans ALTER COLUMN image_height DROP NOT NULL;
ALTER TABLE plans ADD CONSTRAINT plans_image_by_kind CHECK (
    (kind = 'floorplan') = (image_file_id IS NOT NULL)
    AND (image_file_id IS NULL) = (image_width IS NULL)
    AND (image_file_id IS NULL) = (image_height IS NULL));
-- The enclosure of a board (optional catalog variant; its capabilities give
-- rows x TE per row). catalog_variant_id keeps it after a catalog deletion
-- (the BOM still finds its snapshot, D229).
ALTER TABLE plans ADD COLUMN enclosure_variant_id uuid REFERENCES product_variants (id) ON DELETE SET NULL;
ALTER TABLE plans ADD COLUMN enclosure_catalog_variant_id uuid;
ALTER TABLE plans ADD CONSTRAINT plans_enclosure_board CHECK (kind = 'board' OR enclosure_catalog_variant_id IS NULL);
CREATE INDEX plans_enclosure_variant_idx ON plans (enclosure_variant_id);

-- Rows of DIN rail; capacity in TE (17.5 mm), one decimal.
CREATE TABLE board_rows (
    plan_id     uuid NOT NULL,
    id          uuid NOT NULL,
    tenant_id   uuid NOT NULL,
    capacity_te numeric(5, 1) NOT NULL CHECK (capacity_te > 0),
    position    integer NOT NULL,
    PRIMARY KEY (plan_id, id),
    FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE board_modules (
    plan_id            uuid NOT NULL,
    id                 uuid NOT NULL,
    tenant_id          uuid NOT NULL,
    row_id             uuid NOT NULL,
    offset_te          numeric(5, 1) NOT NULL CHECK (offset_te >= 0),
    variant_id         uuid REFERENCES product_variants (id) ON DELETE SET NULL,
    catalog_variant_id uuid,
    label              text NOT NULL DEFAULT '' CHECK (char_length(label) <= 100),
    existing           boolean NOT NULL DEFAULT false,
    addon_variant_ids  uuid[] NOT NULL DEFAULT '{}',
    instance_values    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(instance_values) = 'object'),
    position           integer NOT NULL,
    PRIMARY KEY (plan_id, id),
    -- Rows and modules are replaced together (modules first).
    FOREIGN KEY (plan_id, row_id) REFERENCES board_rows (plan_id, id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX board_modules_variant_idx ON board_modules (variant_id);

-- Bus lines of a version (one system with topology bus each). The id is
-- kept by the version copy, so the key is per version.
CREATE TABLE bus_lines (
    version_id      uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    product_type_id uuid NOT NULL REFERENCES product_types (id) ON DELETE CASCADE,
    name            text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 100),
    -- KNX area/line or HDL subnet, free text for later programming.
    address         text NOT NULL DEFAULT '' CHECK (char_length(address) <= 50),
    position        integer NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version_id, id),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX bus_lines_name_key ON bus_lines (version_id, product_type_id, lower(name));
CREATE INDEX bus_lines_product_type_idx ON bus_lines (product_type_id);

-- Explicit assignments of plan items (placements, board modules) to a bus
-- line or a gateway. Items are referenced by (plan_id, item_id) without a
-- foreign key to the content rows (D340): a content save never touches
-- them; dangling ones are ignored (3d's checks report them).
CREATE TABLE network_assignments (
    plan_id         uuid NOT NULL,
    item_id         uuid NOT NULL,
    tenant_id       uuid NOT NULL,
    version_id      uuid NOT NULL,
    bus_line_id     uuid,
    gateway_plan_id uuid,
    gateway_item_id uuid,
    pinned          boolean NOT NULL DEFAULT true,
    PRIMARY KEY (plan_id, item_id),
    CHECK ((gateway_plan_id IS NULL) = (gateway_item_id IS NULL)),
    CHECK ((bus_line_id IS NULL) <> (gateway_plan_id IS NULL)),
    FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (version_id, bus_line_id) REFERENCES bus_lines (version_id, id) ON DELETE CASCADE
);
CREATE INDEX network_assignments_version_idx ON network_assignments (version_id);

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_rows', 'board_modules', 'bus_lines', 'network_assignments'] LOOP
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
DROP TABLE network_assignments;
DROP TABLE bus_lines;
DROP TABLE board_modules;
DROP TABLE board_rows;
DELETE FROM plans WHERE kind = 'board';
ALTER TABLE plans DROP CONSTRAINT plans_enclosure_board;
ALTER TABLE plans DROP COLUMN enclosure_catalog_variant_id;
ALTER TABLE plans DROP COLUMN enclosure_variant_id;
ALTER TABLE plans DROP CONSTRAINT plans_image_by_kind;
ALTER TABLE plans ALTER COLUMN image_file_id SET NOT NULL;
ALTER TABLE plans ALTER COLUMN image_width SET NOT NULL;
ALTER TABLE plans ALTER COLUMN image_height SET NOT NULL;
ALTER TABLE plans DROP CONSTRAINT plans_kind_check;
ALTER TABLE plans ADD CONSTRAINT plans_kind_check CHECK (kind IN ('floorplan'));
