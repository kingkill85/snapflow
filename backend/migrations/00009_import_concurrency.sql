-- +goose Up
-- Catalog import, after review (D146, D147, D149): add-on lists get a version, applies
-- and undos serialise on a row instead of an advisory lock, and a preview
-- stores what part of the catalog it read and the files of its pictures.

-- The version of a variant's add-on list. Replacing the list bumps it (and
-- locks the variant row, so a concurrent REPEATABLE READ writer of the same
-- list fails with a serialization error instead of merging lists). It is not
-- updated_at: editing add-ons must not make an open variant form stale (D56).
ALTER TABLE product_variants ADD COLUMN addons_updated_at timestamptz NOT NULL DEFAULT now();

-- One row that every apply and undo updates first in its REPEATABLE READ
-- transaction (features/imports). A second one waits for the first; once
-- the first commits, the waiter's update fails with a serialization error
-- (the row changed after its snapshot), and database.InTx runs it again
-- with a fresh snapshot, which sees the first one's writes.
CREATE TABLE import_lock (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    generation bigint NOT NULL DEFAULT 0
);
INSERT INTO import_lock DEFAULT VALUES;

-- catalog_scope: what the preview read of the catalog (scope pairs, model
-- numbers, SKUs, add-on references, category and type values); the catalog
-- token covers only that part. images: the files stored for the run's
-- pictures, by picture part name, reused by later previews of the run.
ALTER TABLE import_runs
    ADD COLUMN catalog_scope jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN images        jsonb NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE import_runs DROP COLUMN images, DROP COLUMN catalog_scope;
DROP TABLE import_lock;
ALTER TABLE product_variants DROP COLUMN addons_updated_at;
