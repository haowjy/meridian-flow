-- +goose Up
-- +goose ENVSUB ON

-- Migration: Normalize all legacy tool names to str_replace_based_edit_tool
-- doc_view, doc_tree, and doc_edit were separate tools that have been unified into
-- str_replace_based_edit_tool (Anthropic's text_editor_20250728 format).
-- This converts all historical blocks so the codebase can drop backward compat.

-- ============================================================
-- Part 1: doc_view / doc_tree → str_replace_based_edit_tool
-- ============================================================

-- tool_use blocks: rename tool_name + add command: "view" to input
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(
  jsonb_set(content, '{tool_name}', '"str_replace_based_edit_tool"'),
  '{input}',
  jsonb_set(COALESCE(content->'input', '{}'), '{command}', '"view"')
)
WHERE content->>'tool_name' IN ('doc_view', 'doc_tree')
AND block_type = 'tool_use';

-- tool_result blocks: rename tool_name only (result data stays as-is)
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(content, '{tool_name}', '"str_replace_based_edit_tool"')
WHERE content->>'tool_name' IN ('doc_view', 'doc_tree')
AND block_type = 'tool_result';

-- ============================================================
-- Part 2: doc_edit → str_replace_based_edit_tool
-- ============================================================
-- doc_edit input already has command/path — same schema as str_replace_based_edit_tool
-- edit commands, so only the tool_name needs updating.

-- tool_use blocks: rename tool_name (input schema is already compatible)
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(content, '{tool_name}', '"str_replace_based_edit_tool"')
WHERE content->>'tool_name' = 'doc_edit'
AND block_type = 'tool_use';

-- tool_result blocks: rename tool_name
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(content, '{tool_name}', '"str_replace_based_edit_tool"')
WHERE content->>'tool_name' = 'doc_edit'
AND block_type = 'tool_result';

-- +goose Down
-- +goose ENVSUB ON

-- Revert: cannot perfectly reconstruct original tool names, but best-effort.

-- Revert Part 2: restore doc_edit for blocks with edit commands
-- doc_edit blocks have edit commands (str_replace, insert, append, create)
-- We can't perfectly distinguish from str_replace_based_edit_tool blocks that also
-- had edit commands, so this is best-effort for rollback.
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(content, '{tool_name}', '"doc_edit"')
WHERE content->>'tool_name' = 'str_replace_based_edit_tool'
AND block_type IN ('tool_use', 'tool_result')
AND content->'input'->>'command' IN ('str_replace', 'insert', 'append', 'create');

-- Revert Part 1: restore doc_view for blocks with view command
-- doc_tree results had type: "tree", doc_view results had type: "document" or "folder".
-- Simple revert: mark all view commands as doc_view (close enough for rollback).
UPDATE ${TABLE_PREFIX}turn_blocks
SET content = jsonb_set(content, '{tool_name}', '"doc_view"')
WHERE content->>'tool_name' = 'str_replace_based_edit_tool'
AND block_type IN ('tool_use', 'tool_result')
AND content->'input'->>'command' = 'view';
