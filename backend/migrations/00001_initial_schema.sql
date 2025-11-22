-- +goose Up
-- +goose ENVSUB ON
-- Consolidated initial schema for Meridian
-- Includes: File system, Multi-turn LLM chat system, User preferences, FTS indexes

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- TRIGGER FUNCTION (Used by multiple tables)
-- =============================================================================

-- Environment-scoped trigger function for auto-updating updated_at
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ${TABLE_PREFIX}update_updated_at_column()
RETURNS TRIGGER AS $$$$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- =============================================================================
-- FILE SYSTEM TABLES
-- =============================================================================

-- Projects: Top-level user projects
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    system_prompt TEXT,  -- Base system prompt for all chats in this project
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
    system_prompt TEXT,  -- Chat-specific system prompt extension
    last_viewed_turn_id UUID,  -- References turns(id), added after turns table
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- Turns: Conversation tree structure (user and assistant turns)
-- Each turn references its previous turn, forming a branching conversation tree
-- System prompts are resolved from: request_params.system, project.system_prompt, chat.system_prompt, selected skills
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}turns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}chats(id) ON DELETE CASCADE,
    prev_turn_id UUID REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error')),
    error TEXT,  -- Error message if status = 'error'
    model TEXT,  -- LLM model used (e.g., "claude-haiku-4-5-20251001")
    input_tokens INT,  -- Token count for input
    output_tokens INT,  -- Token count for output
    request_params JSONB,  -- Request parameters sent to LLM provider (temperature, max_tokens, etc.)
    stop_reason TEXT,  -- Why the turn stopped (end_turn, max_tokens, stop_sequence, tool_use)
    response_metadata JSONB,  -- Provider-specific response metadata (usage stats, etc.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Turn Blocks: Multimodal content for user and assistant turns
-- Accumulated from streaming turn_block deltas during LLM execution
--
-- Block types:
--   User blocks: text, image, reference, partial_reference, tool_result
--   Assistant blocks: text, thinking, tool_use, web_search, web_search_result
--
-- JSONB content structure by block type:
--   - text: null (text in text_content field)
--   - thinking: null (text in text_content, signature in provider_data)
--   - tool_use: {"tool_use_id": "toolu_...", "tool_name": "...", "input": {...}}
--   - tool_result: {"tool_use_id": "toolu_...", "is_error": false}
--   - web_search: {"tool_use_id": "toolu_...", "tool_name": "web_search", "input": {...}}
--   - web_search_result: {"tool_use_id": "toolu_...", "results": [{title, url, page_age}]} or {"tool_use_id": "...", "is_error": true, "error_code": "..."}
--   - image: {"url": "...", "mime_type": "...", "alt_text": "..."}
--   - reference: {"ref_id": "...", "ref_type": "document|image|s3_document", "version_timestamp": "...", "selection_start": 0, "selection_end": 100}
--   - partial_reference: {"ref_id": "...", "ref_type": "document", "selection_start": 0, "selection_end": 100}
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}turn_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    turn_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL CHECK (block_type IN ('text', 'thinking', 'tool_use', 'tool_result', 'image', 'reference', 'partial_reference', 'web_search_use', 'web_search_result')),
    sequence INT NOT NULL,  -- Order within turn (0-indexed)
    text_content TEXT,  -- Plain text content (for text, thinking, tool_result blocks)
    content JSONB,  -- Type-specific structured data
    provider TEXT,  -- LLM provider that generated this block (e.g., "anthropic", "openai")
    provider_data JSONB,  -- Raw provider-specific block data for replay (opaque)
    execution_side TEXT,  -- For tool_use blocks: "server" (provider executes) or "client" (consumer executes)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turn_id, sequence)  -- Prevent duplicate sequences within a turn
);

-- Add foreign key constraint for chats.last_viewed_turn_id (deferred until after turns table exists)
ALTER TABLE ${TABLE_PREFIX}chats
    ADD CONSTRAINT ${TABLE_PREFIX}chats_last_viewed_turn_id_fkey
    FOREIGN KEY (last_viewed_turn_id) REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE SET NULL;

-- =============================================================================
-- USER PREFERENCES TABLE
-- =============================================================================

-- User Preferences Table
-- Stores all user-specific settings as namespaced JSONB for maximum flexibility
--
-- JSONB preferences structure:
-- {
--   "models": {
--     "favorites": [{"provider": "anthropic", "model": "claude-haiku-4-5"}, ...],
--     "default": {"provider": "anthropic", "model": "claude-sonnet-4-5"} | null
--   },
--   "ui": {
--     "theme": "light" | "dark" | "auto",
--     "font_size": 14,
--     "compact_mode": false,
--     "show_word_count": true
--   },
--   "editor": {
--     "auto_save": true,
--     "word_wrap": true,
--     "spellcheck": true
--   },
--   "system_instructions": "Custom system instructions for LLM..." | null,
--   "notifications": {
--     "email_updates": false,
--     "in_app_alerts": true
--   }
-- }
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}user_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    preferences JSONB NOT NULL DEFAULT '{
        "models": {
            "favorites": [],
            "default": null
        },
        "ui": {
            "theme": "light"
        },
        "editor": {},
        "system_instructions": null,
        "notifications": {}
    }'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Document full-text search indexes (multi-language support)
CREATE INDEX idx_documents_content_fts_simple ON ${TABLE_PREFIX}documents USING gin(to_tsvector('simple', content)) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_content_fts_english ON ${TABLE_PREFIX}documents USING gin(to_tsvector('english', content)) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_name_fts_simple ON ${TABLE_PREFIX}documents USING gin(to_tsvector('simple', name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_name_fts_english ON ${TABLE_PREFIX}documents USING gin(to_tsvector('english', name)) WHERE deleted_at IS NULL;

-- Chat system indexes
CREATE INDEX idx_chats_project ON ${TABLE_PREFIX}chats(project_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_chats_user ON ${TABLE_PREFIX}chats(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_chats_last_viewed ON ${TABLE_PREFIX}chats(last_viewed_turn_id);
CREATE INDEX idx_chats_deleted ON ${TABLE_PREFIX}chats(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_turns_chat ON ${TABLE_PREFIX}turns(chat_id);
CREATE INDEX idx_turns_prev ON ${TABLE_PREFIX}turns(prev_turn_id);

CREATE INDEX idx_turn_blocks_turn_sequence ON ${TABLE_PREFIX}turn_blocks(turn_id, sequence);
CREATE INDEX idx_turn_blocks_turn_type ON ${TABLE_PREFIX}turn_blocks(turn_id, block_type);
CREATE INDEX idx_turn_blocks_content_gin ON ${TABLE_PREFIX}turn_blocks USING GIN (content);

-- User preferences indexes
CREATE INDEX idx_user_preferences_preferences_gin ON ${TABLE_PREFIX}user_preferences USING GIN (preferences);

-- =============================================================================
-- TRIGGERS (Auto-update updated_at on row changes)
-- =============================================================================

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}projects
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

CREATE TRIGGER update_folders_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}folders
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}documents
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

CREATE TRIGGER update_chats_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}chats
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

CREATE TRIGGER update_user_preferences_updated_at
    BEFORE UPDATE ON ${TABLE_PREFIX}user_preferences
    FOR EACH ROW
    EXECUTE FUNCTION ${TABLE_PREFIX}update_updated_at_column();

-- =============================================================================
-- COMMENTS (Documentation)
-- =============================================================================

COMMENT ON COLUMN ${TABLE_PREFIX}projects.system_prompt IS 'Base system prompt for all chats in this project';
COMMENT ON COLUMN ${TABLE_PREFIX}chats.system_prompt IS 'Chat-specific system prompt extension';
COMMENT ON TABLE ${TABLE_PREFIX}user_preferences IS 'Stores all user-specific preferences as namespaced JSONB (models, ui, editor, system_instructions, notifications)';
COMMENT ON COLUMN ${TABLE_PREFIX}user_preferences.preferences IS 'Namespaced JSONB containing all preference categories. See migration file for complete schema documentation.';

-- +goose Down
-- Remove all triggers
DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON ${TABLE_PREFIX}user_preferences;
DROP TRIGGER IF EXISTS update_chats_updated_at ON ${TABLE_PREFIX}chats;
DROP TRIGGER IF EXISTS update_documents_updated_at ON ${TABLE_PREFIX}documents;
DROP TRIGGER IF EXISTS update_folders_updated_at ON ${TABLE_PREFIX}folders;
DROP TRIGGER IF EXISTS update_projects_updated_at ON ${TABLE_PREFIX}projects;

-- Remove trigger function
DROP FUNCTION IF EXISTS ${TABLE_PREFIX}update_updated_at_column() CASCADE;

-- Remove all indexes
DROP INDEX IF EXISTS idx_user_preferences_preferences_gin;
DROP INDEX IF EXISTS idx_turn_blocks_content_gin;
DROP INDEX IF EXISTS idx_turn_blocks_turn_type;
DROP INDEX IF EXISTS idx_turn_blocks_turn_sequence;
DROP INDEX IF EXISTS idx_turns_prev;
DROP INDEX IF EXISTS idx_turns_chat;
DROP INDEX IF EXISTS idx_chats_deleted;
DROP INDEX IF EXISTS idx_chats_last_viewed;
DROP INDEX IF EXISTS idx_chats_user;
DROP INDEX IF EXISTS idx_chats_project;
DROP INDEX IF EXISTS idx_documents_name_fts_english;
DROP INDEX IF EXISTS idx_documents_name_fts_simple;
DROP INDEX IF EXISTS idx_documents_content_fts_english;
DROP INDEX IF EXISTS idx_documents_content_fts_simple;
DROP INDEX IF EXISTS idx_documents_deleted;
DROP INDEX IF EXISTS idx_documents_root_unique;
DROP INDEX IF EXISTS idx_documents_project_folder;
DROP INDEX IF EXISTS idx_folders_deleted;
DROP INDEX IF EXISTS idx_folders_root_unique;
DROP INDEX IF EXISTS idx_folders_project_parent;
DROP INDEX IF EXISTS idx_projects_deleted;
DROP INDEX IF EXISTS idx_projects_user_name;

-- Drop all tables in reverse dependency order
DROP TABLE IF EXISTS ${TABLE_PREFIX}user_preferences CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}turn_blocks CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}turns CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}chats CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}documents CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}folders CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}projects CASCADE;

-- Note: Don't drop uuid-ossp extension - Supabase manages it globally
-- Other schemas (auth, storage, etc.) depend on it
