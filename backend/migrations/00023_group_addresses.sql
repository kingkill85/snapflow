-- +goose Up
-- KNX group addresses (step 3e review): the communication objects of a
-- function are catalog data on the function type, and the assigned group
-- addresses are stored per version so their numbers never change.

-- The KNX communication objects of a function: [{key, name (i18n), dpst}].
ALTER TABLE function_types ADD COLUMN knx_objects jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(knx_objects) = 'array');

-- Seeded by the key rules the export used until now (D422).
UPDATE function_types SET knx_objects = CASE
    WHEN key LIKE '%dimm%' THEN '[
        {"key": "switch", "name": {"en": "Switch", "de": "Schalten"}, "dpst": "DPST-1-1"},
        {"key": "switch_status", "name": {"en": "Switch status", "de": "Status Schalten"}, "dpst": "DPST-1-1"},
        {"key": "dim_relative", "name": {"en": "Dim relative", "de": "Dimmen relativ"}, "dpst": "DPST-3-7"},
        {"key": "brightness", "name": {"en": "Brightness value", "de": "Helligkeitswert"}, "dpst": "DPST-5-1"},
        {"key": "brightness_status", "name": {"en": "Brightness status", "de": "Status Helligkeit"}, "dpst": "DPST-5-1"}]'::jsonb
    WHEN key ~ '(blind|curtain|shutter|shade|motor|jalousie|rollo)' THEN '[
        {"key": "up_down", "name": {"en": "Up/Down", "de": "Auf/Ab"}, "dpst": "DPST-1-8"},
        {"key": "stop_step", "name": {"en": "Stop/Step", "de": "Stopp/Lamelle"}, "dpst": "DPST-1-7"},
        {"key": "position", "name": {"en": "Position", "de": "Position"}, "dpst": "DPST-5-1"},
        {"key": "position_status", "name": {"en": "Position status", "de": "Status Position"}, "dpst": "DPST-5-1"}]'::jsonb
    WHEN key ~ '(input|sensor|button|push)' THEN '[
        {"key": "switch", "name": {"en": "Switch", "de": "Schalten"}, "dpst": "DPST-1-1"}]'::jsonb
    ELSE '[
        {"key": "switch", "name": {"en": "Switch", "de": "Schalten"}, "dpst": "DPST-1-1"},
        {"key": "switch_status", "name": {"en": "Switch status", "de": "Status Schalten"}, "dpst": "DPST-1-1"}]'::jsonb
END;

-- The main and middle group of each floorplan zone (zone_id = the nil uuid
-- for the needs outside every zone), assigned once and never renumbered.
-- No foreign keys to plans or zones: the numbers of removed plans and zones
-- stay reserved.
CREATE TABLE group_address_groups (
    tenant_id  uuid NOT NULL,
    version_id uuid NOT NULL,
    plan_id    uuid NOT NULL,
    zone_id    uuid NOT NULL,
    main       smallint NOT NULL CHECK (main BETWEEN 0 AND 31),
    middle     smallint NOT NULL CHECK (middle BETWEEN 0 AND 7),
    PRIMARY KEY (version_id, plan_id, zone_id),
    UNIQUE (version_id, main, middle),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- One group address per communication object of a need, assigned once and
-- never renumbered; rows of removed needs stay (their numbers are not
-- reused) and are left out of the export.
CREATE TABLE group_addresses (
    tenant_id    uuid NOT NULL,
    version_id   uuid NOT NULL,
    need_plan_id uuid NOT NULL,
    need_id      uuid NOT NULL,
    object_key   text NOT NULL,
    main         smallint NOT NULL CHECK (main BETWEEN 0 AND 31),
    middle       smallint NOT NULL CHECK (middle BETWEEN 0 AND 7),
    sub          smallint NOT NULL CHECK (sub BETWEEN 0 AND 255),
    name         text NOT NULL CHECK (char_length(name) <= 255),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version_id, need_plan_id, need_id, object_key),
    UNIQUE (version_id, main, middle, sub),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['group_address_groups', 'group_addresses'] LOOP
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
DROP TABLE group_addresses;
DROP TABLE group_address_groups;
ALTER TABLE function_types DROP COLUMN knx_objects;
