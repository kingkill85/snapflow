-- +goose Up
-- One counter table for every numbered document of a version (D456):
-- kind 'proposal' for proposals, the installation kinds as before. Owned by
-- the installation feature; proposals reserve through its service.
CREATE TABLE document_counters (
    version_id uuid NOT NULL,
    kind       text NOT NULL,
    tenant_id  uuid NOT NULL,
    last_seq   integer NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (version_id, kind),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO document_counters (version_id, kind, tenant_id, last_seq)
SELECT version_id, 'proposal', tenant_id, last_seq FROM proposal_counters;
INSERT INTO document_counters (version_id, kind, tenant_id, last_seq)
SELECT version_id, kind, tenant_id, last_seq FROM generated_document_counters;

ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_counters
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.access_all', true) = 'on')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.access_all', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON document_counters TO snapflow_app;

DROP TABLE proposal_counters;
DROP TABLE generated_document_counters;

-- +goose Down
CREATE TABLE proposal_counters (
    version_id uuid PRIMARY KEY,
    tenant_id  uuid NOT NULL,
    last_seq   integer NOT NULL CHECK (last_seq > 0),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE generated_document_counters (
    version_id uuid NOT NULL,
    kind       text NOT NULL,
    tenant_id  uuid NOT NULL,
    last_seq   integer NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (version_id, kind),
    FOREIGN KEY (version_id, tenant_id) REFERENCES project_versions (id, tenant_id) ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO proposal_counters (version_id, tenant_id, last_seq)
SELECT version_id, tenant_id, last_seq FROM document_counters WHERE kind = 'proposal';
INSERT INTO generated_document_counters (version_id, kind, tenant_id, last_seq)
SELECT version_id, kind, tenant_id, last_seq FROM document_counters WHERE kind <> 'proposal';

-- +goose StatementBegin
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['proposal_counters', 'generated_document_counters'] LOOP
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

DROP TABLE document_counters;
