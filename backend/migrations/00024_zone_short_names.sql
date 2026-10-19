-- +goose Up
-- An optional short name of a zone (at most 12 characters) for the channel
-- labels (step 3e review); empty: the labels derive one from the name.
ALTER TABLE plan_zones ADD COLUMN short_name text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE plan_zones DROP COLUMN short_name;
