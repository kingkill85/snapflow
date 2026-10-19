-- +goose Up
-- Addressing (step 3e review): the addressing scheme is a product type
-- setting instead of a key prefix; device addresses are unique per version
-- in the database; HDL ids are 1-254.

-- The scheme of a system's device addresses. Set from the rule it replaces:
-- key knx… on a bus → KNX individual address, hdl… on a bus → HDL Buspro,
-- every wireless system → EUI-64 (Zigbee IEEE), else none.
ALTER TABLE product_types ADD COLUMN addressing text NOT NULL DEFAULT 'none'
    CHECK (addressing IN ('knx_individual', 'hdl', 'eui64', 'none'));
UPDATE product_types SET addressing = CASE
    WHEN topology = 'bus' AND key LIKE 'knx%' THEN 'knx_individual'
    WHEN topology = 'bus' AND key LIKE 'hdl%' THEN 'hdl'
    WHEN topology = 'wireless' THEN 'eui64'
    ELSE 'none' END;
ALTER TABLE product_types ADD CONSTRAINT product_types_addressing_topology_check CHECK (
    addressing = 'none'
    OR (addressing IN ('knx_individual', 'hdl') AND topology = 'bus')
    OR (addressing = 'eui64' AND topology = 'wireless'));

-- HDL Buspro subnet and device ids are 1-254 (0 and 255 are reserved).
UPDATE device_addresses SET hdl_subnet = NULL, hdl_device = NULL WHERE hdl_subnet = 0 OR hdl_device = 0;
ALTER TABLE device_addresses DROP CONSTRAINT device_addresses_hdl_subnet_check,
    DROP CONSTRAINT device_addresses_hdl_device_check;
ALTER TABLE device_addresses ADD CONSTRAINT device_addresses_hdl_subnet_check CHECK (hdl_subnet BETWEEN 1 AND 254),
    ADD CONSTRAINT device_addresses_hdl_device_check CHECK (hdl_device BETWEEN 1 AND 254);

-- Duplicates of earlier versions of the rule (rows of removed items were
-- only ignored): the newest row keeps the address, the others lose it.
UPDATE device_addresses d SET knx_area = NULL, knx_line = NULL, knx_device = NULL
FROM (SELECT plan_id, item_id, row_number() OVER (PARTITION BY version_id, knx_area, knx_line, knx_device
        ORDER BY pinned DESC, updated_at DESC, plan_id, item_id) AS n
      FROM device_addresses WHERE knx_device IS NOT NULL) x
WHERE x.n > 1 AND d.plan_id = x.plan_id AND d.item_id = x.item_id;
UPDATE device_addresses d SET hdl_subnet = NULL, hdl_device = NULL
FROM (SELECT plan_id, item_id, row_number() OVER (PARTITION BY version_id, hdl_subnet, hdl_device
        ORDER BY pinned DESC, updated_at DESC, plan_id, item_id) AS n
      FROM device_addresses WHERE hdl_device IS NOT NULL) x
WHERE x.n > 1 AND d.plan_id = x.plan_id AND d.item_id = x.item_id;
UPDATE device_addresses d SET ieee = NULL
FROM (SELECT plan_id, item_id, row_number() OVER (PARTITION BY version_id, ieee
        ORDER BY pinned DESC, updated_at DESC, plan_id, item_id) AS n
      FROM device_addresses WHERE ieee IS NOT NULL) x
WHERE x.n > 1 AND d.plan_id = x.plan_id AND d.item_id = x.item_id;

-- A row is pinned only when it holds an address (a note alone is not).
UPDATE device_addresses SET pinned = false
WHERE knx_device IS NULL AND hdl_device IS NULL AND ieee IS NULL;

-- Unique addresses per version. Constraints (not partial indexes) so they
-- can be checked at commit: an auto-assign or a batch may swap addresses
-- between rows. NULLs are distinct, so rows without the address never
-- collide.
ALTER TABLE device_addresses
    ADD CONSTRAINT device_addresses_knx_key UNIQUE (version_id, knx_area, knx_line, knx_device) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT device_addresses_hdl_key UNIQUE (version_id, hdl_subnet, hdl_device) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT device_addresses_ieee_key UNIQUE (version_id, ieee) DEFERRABLE INITIALLY DEFERRED;

-- +goose Down
ALTER TABLE device_addresses DROP CONSTRAINT device_addresses_knx_key,
    DROP CONSTRAINT device_addresses_hdl_key, DROP CONSTRAINT device_addresses_ieee_key;
ALTER TABLE device_addresses DROP CONSTRAINT device_addresses_hdl_subnet_check,
    DROP CONSTRAINT device_addresses_hdl_device_check;
ALTER TABLE device_addresses ADD CONSTRAINT device_addresses_hdl_subnet_check CHECK (hdl_subnet BETWEEN 0 AND 254),
    ADD CONSTRAINT device_addresses_hdl_device_check CHECK (hdl_device BETWEEN 0 AND 254);
ALTER TABLE product_types DROP COLUMN addressing;
