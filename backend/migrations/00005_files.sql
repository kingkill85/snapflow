-- +goose Up
-- Uploaded files (variant images first). The bytes live on disk under
-- STORAGE_DIR, addressed by their SHA-256 (features/files); this table holds
-- their metadata. The same bytes are stored once (sha256 is unique).
CREATE TABLE files (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sha256       text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type text NOT NULL,
    size         bigint NOT NULL CHECK (size >= 0),
    -- Pixel size of images; NULL for other files.
    width        integer CHECK (width > 0),
    height       integer CHECK (height > 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE files;
