-- +goose Up
-- +goose ENVSUB ON
-- Initial schema for Meridian: file system + LLM chat system

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- FILE SYSTEM TABLES
-- ============================================================================

-- Projects table
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- Folders table (real folder entities for hierarchy)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}folders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES ${TABLE_PREFIX}folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    UNIQUE(project_id, parent_id, name)
);

-- Documents table
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE RESTRICT,
    folder_id UUID REFERENCES ${TABLE_PREFIX}folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL,
    UNIQUE(project_id, folder_id, name)
);

-- ============================================================================
-- LLM CHAT SYSTEM TABLES
-- ============================================================================

-- Chats table (chat sessions)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- Turns table (conversation tree structure)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}turns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}chats(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    system_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Content blocks table (multimodal user input)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}content_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    turn_id UUID NOT NULL REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL CHECK (block_type IN ('text', 'image', 'reference', 'partial_reference')),
    sequence INT NOT NULL,
    text_content TEXT,
    version_timestamp TIMESTAMPTZ,
    ref_id UUID,
    ref_type TEXT CHECK (ref_type IN ('document', 'image', 's3_document')),
    image_url TEXT,
    image_mime_type TEXT,
    selection_start INT,
    selection_end INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Assistant responses table (AI output cache)
CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}assistant_responses (
    turn_id UUID PRIMARY KEY REFERENCES ${TABLE_PREFIX}turns(id) ON DELETE CASCADE,
    thinking TEXT,
    response TEXT,
    token_count INT,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- File system indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}projects_user_name ON ${TABLE_PREFIX}projects(user_id, name);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}folders_project_parent ON ${TABLE_PREFIX}folders(project_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}folders_root_unique ON ${TABLE_PREFIX}folders(project_id, name) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}documents_project_id ON ${TABLE_PREFIX}documents(project_id);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}documents_project_folder ON ${TABLE_PREFIX}documents(project_id, folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}documents_root_unique ON ${TABLE_PREFIX}documents(project_id, name) WHERE folder_id IS NULL;

-- Chat system indexes
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}chats_project ON ${TABLE_PREFIX}chats(project_id);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}chats_user ON ${TABLE_PREFIX}chats(user_id);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}turns_chat ON ${TABLE_PREFIX}turns(chat_id);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}turns_parent ON ${TABLE_PREFIX}turns(parent_id);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}content_blocks_turn_seq ON ${TABLE_PREFIX}content_blocks(turn_id, sequence);
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}content_blocks_ref ON ${TABLE_PREFIX}content_blocks(ref_id) WHERE ref_id IS NOT NULL;

-- Soft delete indexes
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}projects_deleted_at ON ${TABLE_PREFIX}projects(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}folders_deleted_at ON ${TABLE_PREFIX}folders(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}documents_deleted_at ON ${TABLE_PREFIX}documents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${TABLE_PREFIX}chats_deleted_at ON ${TABLE_PREFIX}chats(deleted_at) WHERE deleted_at IS NOT NULL;

-- +goose ENVSUB OFF

-- +goose Down
-- +goose ENVSUB ON
-- Drop tables in reverse dependency order

-- Drop soft delete indexes
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}chats_deleted_at;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_deleted_at;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}folders_deleted_at;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}projects_deleted_at;

DROP INDEX IF EXISTS idx_${TABLE_PREFIX}content_blocks_ref;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}content_blocks_turn_seq;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}turns_parent;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}turns_chat;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}chats_user;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}chats_project;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_root_unique;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_project_folder;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_project_id;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}folders_root_unique;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}folders_project_parent;
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}projects_user_name;

DROP TABLE IF EXISTS ${TABLE_PREFIX}assistant_responses CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}content_blocks CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}turns CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}chats CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}documents CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}folders CASCADE;
DROP TABLE IF EXISTS ${TABLE_PREFIX}projects CASCADE;

-- +goose ENVSUB OFF
