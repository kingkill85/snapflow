-- +goose Up
-- Exchange rates online (spec "Exchange rates online"): a project's rate may
-- be missing (a non-USD project before its rate is set), and remembers where
-- it came from and when. USD projects keep the rate 1 without a date.
ALTER TABLE projects
    ALTER COLUMN exchange_rate DROP NOT NULL,
    -- No default: a non-USD project starts without a rate (D274); the
    -- service always sets the rate.
    ALTER COLUMN exchange_rate DROP DEFAULT,
    ADD COLUMN exchange_rate_date     timestamptz,
    -- 'online' (fetched from the provider, date = the provider's update) or
    -- 'manual' (typed in, date = when); NULL for USD and for no rate.
    ADD COLUMN exchange_rate_source   text CHECK (exchange_rate_source IN ('online', 'manual')),
    ADD COLUMN exchange_rate_provider text NOT NULL DEFAULT '';

-- A non-USD rate of exactly 1 was D170's placeholder, not a rate anyone
-- entered (except for currencies pegged 1:1 to the dollar): no rate yet.
UPDATE projects SET exchange_rate = NULL
WHERE currency NOT IN ('USD', 'BMD', 'BSD', 'PAB') AND exchange_rate = 1;
-- Rates of other existing non-USD projects were typed in.
UPDATE projects SET exchange_rate_source = 'manual', exchange_rate_date = updated_at
WHERE currency <> 'USD' AND exchange_rate IS NOT NULL;
UPDATE projects SET exchange_rate = 1 WHERE currency = 'USD' AND exchange_rate IS DISTINCT FROM 1;
ALTER TABLE projects ADD CONSTRAINT projects_usd_rate CHECK (currency <> 'USD' OR exchange_rate = 1);

-- Proposals remember the rate's date and source they were converted at.
ALTER TABLE proposals
    ADD COLUMN exchange_rate_date   timestamptz,
    ADD COLUMN exchange_rate_source text;

-- +goose Down
ALTER TABLE proposals DROP COLUMN exchange_rate_source, DROP COLUMN exchange_rate_date;
UPDATE projects SET exchange_rate = 1 WHERE exchange_rate IS NULL;
ALTER TABLE projects
    DROP CONSTRAINT projects_usd_rate,
    DROP COLUMN exchange_rate_provider,
    DROP COLUMN exchange_rate_source,
    DROP COLUMN exchange_rate_date,
    ALTER COLUMN exchange_rate SET NOT NULL,
    ALTER COLUMN exchange_rate SET DEFAULT 1;
