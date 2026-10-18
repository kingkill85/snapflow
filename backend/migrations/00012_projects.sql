-- +goose Up
-- Tenant soft delete (D13): a partner tenant with projects is archived, not
-- deleted.
ALTER TABLE tenants ADD COLUMN archived_at timestamptz;

-- Row-level security (D12). The app runs tenant-scoped work as snapflow_app
-- (database.InScope: SET LOCAL ROLE plus app.tenant_id / app.access_all).
-- The role is not a superuser and has no BYPASSRLS, so the policies apply
-- even when the connecting user is a superuser (development, tests). Roles
-- belong to the server, not the database: the role is created once and kept
-- by the Down migration (other databases on the server may use it).
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'snapflow_app') THEN
        CREATE ROLE snapflow_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
END
$$;
-- +goose StatementEnd
GRANT snapflow_app TO CURRENT_USER;

-- Project numbers: <year>-<sequence per tenant and year>. One row per tenant
-- and year, incremented under its row lock, so parallel creates get distinct
-- numbers.
CREATE TABLE project_number_counters (
    tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    year        integer NOT NULL,
    last_number integer NOT NULL CHECK (last_number > 0),
    PRIMARY KEY (tenant_id, year)
);

CREATE TABLE projects (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- RESTRICT: a tenant with projects is archived instead (D13).
    tenant_id        uuid NOT NULL REFERENCES tenants (id),
    number           text NOT NULL,
    name             text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    language         text NOT NULL,
    -- Catalog prices are USD (D19); exchange_rate is units of currency per 1 USD.
    currency         text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
    exchange_rate    numeric(14, 6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
    customer_name    text NOT NULL DEFAULT '',
    customer_company text NOT NULL DEFAULT '',
    customer_email   text NOT NULL DEFAULT '',
    customer_phone   text NOT NULL DEFAULT '',
    customer_address text NOT NULL DEFAULT '',
    notes            text NOT NULL DEFAULT '',
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, number),
    -- Target of the children's (project_id, tenant_id) keys, which keep their
    -- tenant_id equal to the project's (ON UPDATE CASCADE on a move).
    UNIQUE (id, tenant_id)
);
CREATE INDEX projects_tenant_updated_idx ON projects (tenant_id, updated_at DESC);
CREATE INDEX projects_updated_idx ON projects (updated_at DESC);
CREATE INDEX projects_created_by_idx ON projects (created_by);

CREATE TABLE project_versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    project_id uuid NOT NULL,
    name       text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 100),
    position   integer NOT NULL,
    notes      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE (project_id, position)
);
CREATE UNIQUE INDEX project_versions_name_key ON project_versions (project_id, lower(name));

-- The systems a project uses (D41/D99).
CREATE TABLE project_product_types (
    tenant_id       uuid NOT NULL,
    project_id      uuid NOT NULL,
    -- RESTRICT: a product type a project uses cannot be deleted (product_type.in_use).
    product_type_id uuid NOT NULL REFERENCES product_types (id),
    PRIMARY KEY (project_id, product_type_id),
    FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX project_product_types_type_idx ON project_product_types (product_type_id);

-- Every tenant-owned table: ENABLE + FORCE row-level security with the same
-- policy (also the WITH CHECK of inserts and updates).
-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['project_number_counters', 'projects', 'project_versions', 'project_product_types'] LOOP
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
DROP TABLE project_product_types;
DROP TABLE project_versions;
DROP TABLE projects;
DROP TABLE project_number_counters;
ALTER TABLE tenants DROP COLUMN archived_at;
