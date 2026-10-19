-- +goose Up
-- Installation (step 3e): device addresses for programming the bus and
-- wireless systems, and the generated installation documents (manual,
-- channel labels) of a version.

-- Addresses of plan items (placements, board modules), referenced by
-- (plan_id, item_id) without a foreign key to the content rows (D340).
-- Uniqueness per version is a service rule over current items (rows of
-- removed items are ignored and cleaned on the next address write), and the
-- checks report duplicates.
CREATE TABLE device_addresses (
    plan_id     uuid NOT NULL,
    item_id     uuid NOT NULL,
    tenant_id   uuid NOT NULL,
    version_id  uuid NOT NULL,
    -- KNX individual address area.line.device.
    knx_area    smallint CHECK (knx_area BETWEEN 0 AND 15),
    knx_line    smallint CHECK (knx_line BETWEEN 0 AND 15),
    knx_device  smallint CHECK (knx_device BETWEEN 0 AND 255),
    -- HDL Buspro subnet and device id.
    hdl_subnet  smallint CHECK (hdl_subnet BETWEEN 0 AND 254),
    hdl_device  smallint CHECK (hdl_device BETWEEN 0 AND 254),
    -- Zigbee IEEE address, 16 upper-case hex digits.
    ieee        text CHECK (ieee ~ '^[0-9A-F]{16}$'),
    note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
    -- true: set by hand (auto-assign never changes it); false: auto-assigned.
    pinned      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plan_id, item_id),
    CHECK ((knx_area IS NULL) = (knx_line IS NULL) AND (knx_line IS NULL) = (knx_device IS NULL)),
    CHECK ((hdl_subnet IS NULL) = (hdl_device IS NULL)),
    FOREIGN KEY (plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX device_addresses_version_idx ON device_addresses (version_id);

-- The last sequence of a version per document kind (numbers never reused).
CREATE TABLE generated_document_counters (
    version_id uuid NOT NULL,
    kind       text NOT NULL,
    tenant_id  uuid NOT NULL,
    last_seq   integer NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (version_id, kind),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- Generated installation documents (proposals keep their own table, D420).
CREATE TABLE generated_documents (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    version_id uuid NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('installation_manual', 'channel_labels')),
    seq        integer NOT NULL CHECK (seq > 0),
    number     text NOT NULL,
    exporter   text NOT NULL,
    language   text NOT NULL,
    -- RESTRICT: a document's file is never removed under it.
    file_id    uuid NOT NULL REFERENCES files (id),
    file_name  text NOT NULL,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (version_id, kind, seq),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX generated_documents_version_idx ON generated_documents (version_id, created_at);
CREATE INDEX generated_documents_file_idx ON generated_documents (file_id);

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['device_addresses', 'generated_document_counters', 'generated_documents'] LOOP
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
DROP TABLE generated_documents;
DROP TABLE generated_document_counters;
DROP TABLE device_addresses;
