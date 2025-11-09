-- +goose Up
-- +goose ENVSUB ON
-- Initial schema for Meridian: File system + Multi-turn LLM chat system

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- FILE SYSTEM TABLES
-- =============================================================================

-- Projects: Top-level user projects
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Folders: Hierarchical folder structure within projects
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}folders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES ${TABLE_PREFIX}folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(project_id, parent_id, name)
);

-- Documents: Document content within folders
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES ${TABLE_PREFIX}folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    word_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(project_id, folder_id, name)
);

-- =============================================================================
-- LLM CHAT SYSTEM TABLES
-- =============================================================================

-- Chats: Chat sessions within projects
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    last_viewed_turn_id UUID,  -- References turns(id), added after turns table
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Turns: Conversation tree structure (user and assistant turns)
-- Each turn references its previous turn, forming a branching conversation tree
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}turns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}chats(id) ON DELETE CASCADE,
    prev_turn_id UUID REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    system_prompt TEXT,  -- Optional system prompt override for this turn
    status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error')),
    error TEXT,  -- Error message if status = 'error'
    model TEXT,  -- LLM model used (e.g., "claude-haiku-4-5-20251001")
    input_tokens INT,  -- Token count for input
    output_tokens INT,  -- Token count for output
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Content Blocks: Multimodal content for user and assistant turns
-- Unified structure using JSONB for type-specific content
--
-- Block types:
--   User blocks: text, image, reference, partial_reference, tool_result
--   Assistant blocks: text, thinking, tool_use
--
-- JSONB content structure by block type:
--   - text: null (text in text_content field)
--   - thinking: {"signature": "4k_a"} (optional, text in text_content)
--   - tool_use: {"tool_use_id": "toolu_...", "tool_name": "...", "input": {...}}
--   - tool_result: {"tool_use_id": "toolu_...", "is_error": false}
--   - image: {"url": "...", "mime_type": "...", "alt_text": "..."}
--   - reference: {"ref_id": "...", "ref_type": "document|image|s3_document", "version_timestamp": "...", "selection_start": 0, "selection_end": 100}
--   - partial_reference: {"ref_id": "...", "ref_type": "document", "selection_start": 0, "selection_end": 100}
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}content_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    turn_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL CHECK (block_type IN ('text', 'thinking', 'tool_use', 'tool_result', 'image', 'reference', 'partial_reference')),
    sequence INT NOT NULL,  -- Order within turn (0-indexed)
    text_content TEXT,  -- Plain text content (for text, thinking, tool_result blocks)
    content JSONB,  -- Type-specific structured data
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turn_id, sequence)  -- Prevent duplicate sequences within a turn
);

-- Add foreign key constraint for chats.last_viewed_turn_id (deferred until after turns table exists)
ALTER TABLE ${TABLE_PREFIX}chats
    ADD CONSTRAINT ${TABLE_PREFIX}chats_last_viewed_turn_id_fkey
    FOREIGN KEY (last_viewed_turn_id) REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE SET NULL;

-- =============================================================================
-- INDEXES
-- =============================================================================

-- File system indexes
CREATE INDEX idx_projects_user_name ON ${TABLE_PREFIX}projects(user_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_deleted ON ${TABLE_PREFIX}projects(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_folders_project_parent ON ${TABLE_PREFIX}folders(project_id, parent_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_folders_root_unique ON ${TABLE_PREFIX}folders(project_id, name) WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_folders_deleted ON ${TABLE_PREFIX}folders(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_documents_project_folder ON ${TABLE_PREFIX}documents(project_id, folder_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_documents_root_unique ON ${TABLE_PREFIX}documents(project_id, name) WHERE folder_id IS NULL AND deleted_at IS NULL;
CREATE INDEX idx_documents_deleted ON ${TABLE_PREFIX}documents(deleted_at) WHERE deleted_at IS NOT NULL;

-- Chat system indexes
CREATE INDEX idx_chats_project ON ${TABLE_PREFIX}chats(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_chats_user ON ${TABLE_PREFIX}chats(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_chats_last_viewed ON ${TABLE_PREFIX}chats(last_viewed_turn_id);
CREATE INDEX idx_chats_deleted ON ${TABLE_PREFIX}chats(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_turns_chat ON ${TABLE_PREFIX}turns(chat_id);
CREATE INDEX idx_turns_prev ON ${TABLE_PREFIX}turns(prev_turn_id);

CREATE INDEX idx_content_blocks_turn_sequence ON ${TABLE_PREFIX}content_blocks(turn_id, sequence);
CREATE INDEX idx_content_blocks_turn_type ON ${TABLE_PREFIX}content_blocks(turn_id, block_type);
CREATE INDEX idx_content_blocks_content_gin ON ${TABLE_PREFIX}content_blocks USING GIN (content);

-- +goose Down
-- Drop all indexes
DROP INDEX IF EXISTS idx_content_blocks_content_gin;
DROP INDEX IF EXISTS idx_content_blocks_turn_type;
DROP INDEX IF EXISTS idx_content_blocks_turn_sequence;
DROP INDEX IF EXISTS idx_turns_prev;
DROP INDEX IF EXISTS idx_turns_chat;
DROP INDEX IF EXISTS idx_chats_deleted;
DROP INDEX IF EXISTS idx_chats_last_viewed;
DROP INDEX IF EXISTS idx_chats_user;
DROP INDEX IF EXISTS idx_chats_project;
DROP INDEX IF EXISTS idx_documents_deleted;
DROP INDEX IF EXISTS idx_documents_root_unique;
DROP INDEX IF EXISTS idx_documents_project_folder;
DROP INDEX IF EXISTS idx_folders_deleted;
DROP INDEX IF EXISTS idx_folders_root_unique;
DROP INDEX IF EXISTS idx_folders_project_parent;
DROP INDEX IF EXISTS idx_projects_deleted;
DROP INDEX IF EXISTS idx_projects_user_name;

-- Drop all tables in reverse dependency order
DROP TABLE IF EXISTS ${TABLE_PREFIX}content_blocks CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}turns CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}chats CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}documents CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}folders CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}projects CASCADE;

-- Drop extension
DROP EXTENSION IF EXISTS "uuid-ossp";
