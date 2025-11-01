-- Simple schema for Meridian backend
-- Just run this ONCE in Supabase SQL Editor to get started

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Development tables (adjust prefix based on your ENVIRONMENT)
CREATE TABLE IF NOT EXISTS dev_projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Folders table (real folder entities for hierarchy)
CREATE TABLE IF NOT EXISTS dev_folders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES dev_folders(id) ON DELETE CASCADE,  -- NULL = root level
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, parent_id, name)  -- No duplicate folder names at same level
);

CREATE INDEX IF NOT EXISTS idx_dev_folders_project_parent ON dev_folders(project_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_folders_root_unique
    ON dev_folders(project_id, name)
    WHERE parent_id IS NULL;

-- Documents table (updated for folder support)
CREATE TABLE IF NOT EXISTS dev_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
    folder_id UUID REFERENCES dev_folders(id) ON DELETE SET NULL,  -- NULL = root level
    name TEXT NOT NULL,  -- Just "Aria", not "Characters/Aria"
    content TEXT NOT NULL,  -- Markdown content
    word_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, folder_id, name)  -- No duplicate doc names in same folder
);

CREATE INDEX IF NOT EXISTS idx_dev_documents_project_id ON dev_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_dev_documents_project_folder ON dev_documents(project_id, folder_id);

-- Insert a test project to get started
INSERT INTO dev_projects (id, user_id, name, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'My First Project',
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- That's it! You're ready to go.
-- When you need test/prod tables later, just copy this and change the prefix.

