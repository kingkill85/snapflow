-- +goose Up
-- Images are stored re-encoded (features/files), so the stored bytes' hash
-- differs from the uploaded bytes'. file_sources remembers which file an
-- uploaded image became, by the SHA-256 of the uploaded bytes, so uploading
-- the same image again (an import previewed again, a re-import) returns the
-- file without decoding it (D149).
CREATE TABLE file_sources (
    source_sha256 text PRIMARY KEY CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    file_id       uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE
);
CREATE INDEX file_sources_file_id_idx ON file_sources (file_id);

-- +goose Down
DROP TABLE file_sources;
