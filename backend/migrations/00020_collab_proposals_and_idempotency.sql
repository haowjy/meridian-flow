-- +goose Up
-- +goose ENVSUB ON

-- Phase 3 foundation:
-- 1) Proposal queue storage (retained terminal states for audit)
-- 2) Idempotency storage for proposal accept/group-accept replay

CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}collab_document_edit_proposals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}documents(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'ai'
        CHECK (source IN ('ai', 'template', 'user_suggestion')),
    producer_agent_type TEXT NOT NULL,
    thread_id UUID NOT NULL,
    turn_id UUID,
    agent_run_id UUID NOT NULL,
    proposal_group_id UUID,
    status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'accepted', 'rejected')),
    yjs_update BYTEA NOT NULL,
    description TEXT,
    created_by_user_id UUID NOT NULL,
    decided_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_proposal_doc_status_created
    ON ${TABLE_PREFIX}collab_document_edit_proposals(document_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_proposal_group_status
    ON ${TABLE_PREFIX}collab_document_edit_proposals(proposal_group_id, status);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_proposal_status_created
    ON ${TABLE_PREFIX}collab_document_edit_proposals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}collab_proposal_thread_turn
    ON ${TABLE_PREFIX}collab_document_edit_proposals(thread_id, turn_id, created_at DESC);

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

-- +goose Down
-- +goose ENVSUB ON

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_idempotency_expires;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_idempotency_scope;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_request_idempotency;

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_proposal_thread_turn;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_proposal_status_created;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_proposal_group_status;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}collab_proposal_doc_status_created;
DROP TABLE IF EXISTS ${TABLE_PREFIX}collab_document_edit_proposals;
