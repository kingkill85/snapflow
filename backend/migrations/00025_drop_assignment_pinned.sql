-- +goose Up
-- A network assignment row exists only when it was set by hand, so it is
-- always pinned; the column carried no information (D456).
ALTER TABLE network_assignments DROP COLUMN pinned;

-- +goose Down
ALTER TABLE network_assignments ADD COLUMN pinned boolean NOT NULL DEFAULT true;
