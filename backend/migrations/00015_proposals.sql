-- +goose Up
-- Proposals (step 2d): the tenant letterhead, the version's introduction and
-- closing texts, and the generated proposal records.

-- Letterhead of a tenant (all optional; without them a proposal shows the
-- tenant name). The logo is an image file of the tenant's scope.
ALTER TABLE tenants
    ADD COLUMN company_name  text NOT NULL DEFAULT '' CHECK (char_length(company_name) <= 200),
    ADD COLUMN address       text NOT NULL DEFAULT '' CHECK (char_length(address) <= 500),
    ADD COLUMN phone         text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 50),
    ADD COLUMN email         text NOT NULL DEFAULT '' CHECK (char_length(email) <= 200),
    ADD COLUMN website       text NOT NULL DEFAULT '' CHECK (char_length(website) <= 200),
    ADD COLUMN logo_file_id  uuid REFERENCES files (id) ON DELETE SET NULL;

-- Optional translatable texts printed before the bill of materials and after
-- the totals (NULL: none).
ALTER TABLE version_pricing
    ADD COLUMN intro_text   jsonb,
    ADD COLUMN closing_text jsonb;

-- The last proposal sequence of a version (numbers are never reused).
CREATE TABLE proposal_counters (
    version_id uuid PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    last_seq   integer NOT NULL CHECK (last_seq > 0),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE proposals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    version_id          uuid NOT NULL,
    seq                 integer NOT NULL CHECK (seq > 0),
    number              text NOT NULL,
    exporter            text NOT NULL,
    language            text NOT NULL,
    -- NULL: the combined proposal; else the product type of a split run.
    product_type_id     uuid,
    product_type_name   jsonb,
    -- RESTRICT: a proposal's file is never removed under it.
    file_id             uuid NOT NULL REFERENCES files (id),
    file_name           text NOT NULL,
    -- Totals snapshot in USD and in the project currency.
    currency            text NOT NULL,
    exchange_rate       numeric(18, 8) NOT NULL,
    subtotal            numeric(14, 2) NOT NULL,
    discount            numeric(14, 2) NOT NULL,
    services            numeric(14, 2) NOT NULL,
    grand_total         numeric(14, 2) NOT NULL,
    converted_subtotal    numeric(18, 4),
    converted_discount    numeric(18, 4),
    converted_services    numeric(18, 4),
    converted_grand_total numeric(18, 4),
    created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- One run may write several documents with the same sequence (split).
    UNIQUE NULLS NOT DISTINCT (version_id, seq, product_type_id),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX proposals_version_idx ON proposals (version_id, created_at);
CREATE INDEX proposals_file_idx ON proposals (file_id);

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['proposal_counters', 'proposals'] LOOP
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
DROP TABLE proposals;
DROP TABLE proposal_counters;
ALTER TABLE version_pricing DROP COLUMN closing_text, DROP COLUMN intro_text;
ALTER TABLE tenants
    DROP COLUMN logo_file_id, DROP COLUMN website, DROP COLUMN email, DROP COLUMN phone,
    DROP COLUMN address, DROP COLUMN company_name;
