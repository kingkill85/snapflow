-- +goose Up
-- File scopes (D79): a file belongs to the catalog (tenant_id NULL) or to one
-- tenant. The same bytes are stored once per scope (the contents on disk are
-- shared, they are addressed by their SHA-256); file_sources likewise.
ALTER TABLE files ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;
ALTER TABLE files DROP CONSTRAINT files_sha256_key;
CREATE UNIQUE INDEX files_scope_sha256_key ON files (tenant_id, sha256) NULLS NOT DISTINCT;

ALTER TABLE file_sources ADD COLUMN tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE;
ALTER TABLE file_sources DROP CONSTRAINT file_sources_pkey;
CREATE UNIQUE INDEX file_sources_scope_key ON file_sources (tenant_id, source_sha256) NULLS NOT DISTINCT;

-- +goose Down
DELETE FROM file_sources WHERE tenant_id IS NOT NULL;
DROP INDEX file_sources_scope_key;
ALTER TABLE file_sources DROP COLUMN tenant_id;
ALTER TABLE file_sources ADD PRIMARY KEY (source_sha256);

DELETE FROM files WHERE tenant_id IS NOT NULL;
DROP INDEX files_scope_sha256_key;
ALTER TABLE files DROP COLUMN tenant_id;
ALTER TABLE files ADD CONSTRAINT files_sha256_key UNIQUE (sha256);
