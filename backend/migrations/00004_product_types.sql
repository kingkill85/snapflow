-- +goose Up
-- Product types are the kinds of device in the global catalog. Their attribute
-- schemas are configuration (platform/attrschema), stored as jsonb.
CREATE TABLE product_types (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key                 text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
    name                jsonb NOT NULL,
    description         jsonb,
    sort_order          integer NOT NULL,
    is_active           boolean NOT NULL DEFAULT true,
    attributes          jsonb NOT NULL DEFAULT '[]',
    instance_attributes jsonb NOT NULL DEFAULT '[]',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE product_types;
