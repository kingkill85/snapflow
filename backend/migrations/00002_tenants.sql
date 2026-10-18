-- +goose Up
CREATE TABLE tenants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL CHECK (btrim(name) <> ''),
    -- Exactly one tenant is the distributor: it runs SnapFlow, owns the
    -- catalog and is home to the admins. All others are partners.
    is_distributor boolean NOT NULL DEFAULT false,
    is_active      boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_name_key ON tenants (lower(name));
CREATE UNIQUE INDEX tenants_one_distributor ON tenants (is_distributor) WHERE is_distributor;

-- +goose Down
DROP TABLE tenants;
