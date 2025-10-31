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

CREATE TABLE IF NOT EXISTS dev_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_tiptap JSONB NOT NULL,
    content_markdown TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_dev_documents_project_id ON dev_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_dev_documents_path ON dev_documents(project_id, path);

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

