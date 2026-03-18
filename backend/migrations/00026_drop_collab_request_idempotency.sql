-- +goose Up
-- +goose ENVSUB ON

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_idempotency_expires;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_idempotency_scope;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_request_idempotency;

-- +goose Down
-- +goose ENVSUB ON

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_request_idempotency (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_scope TEXT NOT NULL
        CHECK (request_scope IN ('proposal_accept', 'group_accept')),
    scope_id UUID NOT NULL,
    request_hash TEXT NOT NULL,
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_idempotency_scope
    ON ${TABLE_PREFIX}collab_request_idempotency(request_scope, scope_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_idempotency_expires
    ON ${TABLE_PREFIX}collab_request_idempotency(expires_at);
