-- +goose Up
-- Step 3a, catalog capabilities (D187-D191, D284-): load types, output kinds
-- with the function types they serve and an optional alternative ("2 relay
-- outputs act as 1 blind output"), the catalog-wide field registry with
-- meanings for the checks, mounting per category with a product override,
-- and the system settings of product types. Global catalog configuration:
-- no tenant data, no row-level security.

-- Load types: what kind of load a need has (LED, halogen, AC motor, ...);
-- channel limits are given per load type.
CREATE TABLE load_types (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key        text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$' AND char_length(key) <= 64),
    name       jsonb NOT NULL,
    sort_order integer NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Output kinds: the kinds of channel a module supplies (dimmer output, relay
-- output, ...). "alternative_count of alternative_kind act as 1 of this
-- kind": e.g. blind output <- 2 relay outputs.
CREATE TABLE output_kinds (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key                 text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$' AND char_length(key) <= 64),
    name                jsonb NOT NULL,
    sort_order          integer NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    -- RESTRICT: a kind another kind names as its alternative cannot be
    -- deleted (output_kind.in_use).
    alternative_kind_id uuid REFERENCES output_kinds (id) ON DELETE RESTRICT,
    alternative_count   integer CHECK (alternative_count BETWEEN 1 AND 16),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((alternative_kind_id IS NULL) = (alternative_count IS NULL)),
    CHECK (alternative_kind_id <> id)
);

-- The function types an output kind serves (a need of that function can be
-- connected to a channel of that kind).
CREATE TABLE output_kind_function_types (
    output_kind_id   uuid NOT NULL REFERENCES output_kinds (id) ON DELETE CASCADE,
    -- RESTRICT: a function type an output kind serves cannot be deleted
    -- (function_type.in_use).
    function_type_id uuid NOT NULL REFERENCES function_types (id) ON DELETE RESTRICT,
    PRIMARY KEY (output_kind_id, function_type_id)
);
CREATE INDEX output_kind_function_types_function_type_idx ON output_kind_function_types (function_type_id);

-- Function types: several needs may share one channel (a circuit), and the
-- load types a need of the function may have (none listed = any).
ALTER TABLE function_types ADD COLUMN allows_circuit boolean NOT NULL DEFAULT false;
CREATE TABLE function_type_load_types (
    function_type_id uuid NOT NULL REFERENCES function_types (id) ON DELETE CASCADE,
    -- RESTRICT: a load type a function type allows cannot be deleted
    -- (load_type.in_use).
    load_type_id     uuid NOT NULL REFERENCES load_types (id) ON DELETE RESTRICT,
    PRIMARY KEY (function_type_id, load_type_id)
);
CREATE INDEX function_type_load_types_load_type_idx ON function_type_load_types (load_type_id);

-- Catalog fields: the catalog-wide registry of known columns (D188). A
-- category attribute links one by key (attributes[].fieldKey) and takes its
-- type, unit and meaning from it.
CREATE TABLE catalog_fields (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$' AND char_length(key) <= 64),
    label          jsonb NOT NULL,
    value_type     text NOT NULL CHECK (value_type IN ('text', 'number', 'integer', 'boolean', 'enum')),
    unit           text CHECK (unit <> ''),
    -- Allowed values of an enum field (attrschema.AttributeOption list).
    options        jsonb NOT NULL DEFAULT '[]',
    -- ETIM feature code (e.g. EF000008), informational.
    etim_feature   text CHECK (etim_feature <> ''),
    -- What the value means for the checks; NULL = just information.
    meaning        text CHECK (meaning IN (
        'channels_supplied', 'channel_limit_w', 'channel_limit_a', 'channel_min_load_w',
        'module_total_a', 'module_total_w',
        'bus_current_used_ma', 'bus_current_supplied_ma', 'bus_devices_max',
        'rail_width_te', 'enclosure_rows', 'enclosure_te_per_row',
        'wireless_places_supplied', 'wireless_place_used', 'zigbee_router', 'motor_type')),
    -- Parameters of the meaning. RESTRICT: output_kind.in_use / load_type.in_use.
    output_kind_id uuid REFERENCES output_kinds (id) ON DELETE RESTRICT,
    load_type_id   uuid REFERENCES load_types (id) ON DELETE RESTRICT,
    sort_order     integer NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_fields_output_kind_idx ON catalog_fields (output_kind_id);
CREATE INDEX catalog_fields_load_type_idx ON catalog_fields (load_type_id);

-- The product types a field's meaning is limited to (none = all, D191).
CREATE TABLE catalog_field_product_types (
    catalog_field_id uuid NOT NULL REFERENCES catalog_fields (id) ON DELETE CASCADE,
    -- RESTRICT: product_type.in_use.
    product_type_id  uuid NOT NULL REFERENCES product_types (id) ON DELETE RESTRICT,
    PRIMARY KEY (catalog_field_id, product_type_id)
);
CREATE INDEX catalog_field_product_types_product_type_idx ON catalog_field_product_types (product_type_id);

-- Mounting (D189): where products of a category are placed; a product may
-- override it (NULL = the category's).
ALTER TABLE categories ADD COLUMN mounting text NOT NULL DEFAULT 'floorplan'
    CHECK (mounting IN ('floorplan', 'board', 'both'));
ALTER TABLE products ADD COLUMN mounting text CHECK (mounting IN ('floorplan', 'board', 'both'));

-- System settings of product types (spec 3a).
ALTER TABLE product_types
    ADD COLUMN default_bus_current_ma integer CHECK (default_bus_current_ma BETWEEN 1 AND 100000),
    ADD COLUMN reserve_percent integer NOT NULL DEFAULT 20 CHECK (reserve_percent BETWEEN 0 AND 90),
    ADD COLUMN bus_devices_max integer CHECK (bus_devices_max BETWEEN 1 AND 100000);

-- Seeds (spec 3a).
INSERT INTO load_types (key, name, sort_order) VALUES
    ('resistive', '{"en": "Resistive", "de": "Ohmsch"}', 1),
    ('led', '{"en": "LED", "de": "LED"}', 2),
    ('halogen', '{"en": "Halogen / incandescent", "de": "Halogen / Glühlampe"}', 3),
    ('inductive', '{"en": "Inductive (transformer)", "de": "Induktiv (Trafo)"}', 4),
    ('capacitive', '{"en": "Capacitive", "de": "Kapazitiv"}', 5),
    ('ac_motor', '{"en": "AC motor", "de": "AC-Motor"}', 6),
    ('dc_motor', '{"en": "DC motor", "de": "DC-Motor"}', 7),
    ('pushbutton', '{"en": "Pushbutton contact", "de": "Tasterkontakt"}', 8);

INSERT INTO output_kinds (key, name, sort_order) VALUES
    ('dimmer_output', '{"en": "Dimmer output", "de": "Dimmerausgang"}', 1),
    ('relay_output', '{"en": "Relay output", "de": "Schaltausgang"}', 2),
    ('blind_output', '{"en": "Blind output", "de": "Jalousieausgang"}', 3),
    ('input', '{"en": "Input", "de": "Eingang"}', 4),
    ('dali_output', '{"en": "DALI output", "de": "DALI-Ausgang"}', 5),
    ('analog_0_10v_output', '{"en": "0–10 V output", "de": "0–10-V-Ausgang"}', 6);
-- 2 relay outputs act as 1 blind output (mixed use per pair).
UPDATE output_kinds SET alternative_kind_id = (SELECT id FROM output_kinds WHERE key = 'relay_output'), alternative_count = 2
WHERE key = 'blind_output';

-- Served function types and circuit flags, for the function type keys that
-- exist (function types are admin data; none are seeded).
INSERT INTO output_kind_function_types (output_kind_id, function_type_id)
SELECT o.id, f.id
FROM (VALUES
    ('dimmer_output', 'dimmer'), ('dimmer_output', 'dimming'), ('dimmer_output', 'switching'),
    ('relay_output', 'switching'), ('relay_output', 'socket'),
    ('blind_output', 'blind'), ('blind_output', 'shutter'), ('blind_output', 'curtain'),
    ('input', 'input'), ('input', 'pushbutton'), ('input', 'contact'), ('input', 'sensor'),
    ('dali_output', 'dimmer'), ('dali_output', 'dimming'), ('dali_output', 'dali'),
    ('analog_0_10v_output', 'dimmer'), ('analog_0_10v_output', 'dimming'), ('analog_0_10v_output', 'analog')
) AS s (kind, function)
JOIN output_kinds o ON o.key = s.kind
JOIN function_types f ON f.key = s.function;
UPDATE function_types SET allows_circuit = true
WHERE key IN ('dimmer', 'dimming', 'switching', 'socket', 'light', 'lighting', 'dali', 'analog');
INSERT INTO function_type_load_types (function_type_id, load_type_id)
SELECT f.id, l.id
FROM (VALUES
    ('blind', 'ac_motor'), ('blind', 'dc_motor'), ('shutter', 'ac_motor'), ('shutter', 'dc_motor'),
    ('curtain', 'ac_motor'), ('curtain', 'dc_motor'),
    ('input', 'pushbutton'), ('pushbutton', 'pushbutton'), ('contact', 'pushbutton'),
    ('dimmer', 'resistive'), ('dimmer', 'led'), ('dimmer', 'halogen'), ('dimmer', 'inductive'), ('dimmer', 'capacitive'),
    ('dimming', 'resistive'), ('dimming', 'led'), ('dimming', 'halogen'), ('dimming', 'inductive'), ('dimming', 'capacitive')
) AS s (function, load)
JOIN function_types f ON f.key = s.function
JOIN load_types l ON l.key = s.load;

-- The SnapFlow 1 workbook's "Dimensions (mm)" column (starter profile, D121)
-- is just information.
INSERT INTO catalog_fields (key, label, value_type, unit, sort_order)
VALUES ('dimensions', '{"en": "Dimensions", "de": "Abmessungen"}', 'text', 'mm', 1);

-- +goose Down
ALTER TABLE product_types DROP COLUMN default_bus_current_ma, DROP COLUMN reserve_percent, DROP COLUMN bus_devices_max;
ALTER TABLE products DROP COLUMN mounting;
ALTER TABLE categories DROP COLUMN mounting;
DROP TABLE catalog_field_product_types;
DROP TABLE catalog_fields;
DROP TABLE function_type_load_types;
ALTER TABLE function_types DROP COLUMN allows_circuit;
DROP TABLE output_kind_function_types;
DROP TABLE output_kinds;
DROP TABLE load_types;
