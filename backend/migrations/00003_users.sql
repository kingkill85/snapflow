-- +goose Up
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    email         text NOT NULL UNIQUE CHECK (email = lower(email)),
    full_name     text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    role          text NOT NULL CHECK (role IN ('admin', 'tenant_admin', 'user')),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_tenant_id_idx ON users (tenant_id);

-- Only the SHA-256 of a session token is stored.
CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   bytea NOT NULL UNIQUE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

-- +goose Down
DROP TABLE sessions;
DROP TABLE users;
