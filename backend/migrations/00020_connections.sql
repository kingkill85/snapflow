-- +goose Up
-- Step 3d, connections and checks: needs connected to channels of board
-- modules or floorplan devices (D340, D378), and the nominal voltage of a
-- product type for converting W into A.

-- Nominal voltage (V) of a system's devices: converts the W of needs into A
-- for limits given in A (module totals, channel limits in A).
ALTER TABLE product_types ADD COLUMN nominal_voltage integer NOT NULL DEFAULT 230
    CHECK (nominal_voltage BETWEEN 1 AND 1000);

-- A connection gives units of a need to one channel of an item. Needs and
-- items are referenced by (plan_id, id) without foreign keys to the content
-- rows (D340, D378): content saves never touch connections; dangling ones
-- are reported by the checks. Plans and the version cascade.
CREATE TABLE connections (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    version_id     uuid NOT NULL,
    need_plan_id   uuid NOT NULL,
    need_id        uuid NOT NULL,
    units          integer NOT NULL CHECK (units BETWEEN 1 AND 100),
    target_plan_id uuid NOT NULL,
    target_item_id uuid NOT NULL,
    -- No foreign key: a deleted or deactivated output kind leaves the
    -- connection dangling (reported), like a removed module.
    output_kind_id uuid NOT NULL,
    -- 1..count of the kind on the item; for an alternative kind in the
    -- alternative's numbering (D303).
    channel_no     integer NOT NULL CHECK (channel_no BETWEEN 1 AND 10000),
    -- Made by hand: auto-connect never moves or removes it.
    pinned         boolean NOT NULL DEFAULT true,
    -- The auto-connect run that made it (one-step undo); null by hand.
    batch_id       uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (need_plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (target_plan_id, tenant_id) REFERENCES plans (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX connections_version_idx ON connections (version_id);
CREATE INDEX connections_need_plan_idx ON connections (need_plan_id);
CREATE INDEX connections_target_plan_idx ON connections (target_plan_id);
CREATE INDEX connections_batch_idx ON connections (batch_id) WHERE batch_id IS NOT NULL;

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connections
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.access_all', true) = 'on')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.access_all', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON connections TO snapflow_app;

-- +goose Down
DROP TABLE connections;
ALTER TABLE product_types DROP COLUMN nominal_voltage;
