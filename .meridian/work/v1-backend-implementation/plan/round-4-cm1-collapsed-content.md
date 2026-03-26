# Phase CM1: collapsed_content Column + Collapse Marker Turn Type

## Scope
Add collapsed_content column to turn_blocks, compute collapsed summaries at tool execution time.

## Files to Create
- `backend/migrations/00036_add_collapsed_content.sql`

## Files to Modify
- `backend/internal/domain/llm/turn_block.go` — add CollapsedContent field
- `backend/internal/service/llm/tools/text_editor.go` — compute collapsed_content on tool result
- `backend/internal/service/llm/tools/search.go` — compute collapsed_content for doc_search results

## Key Details
Migration: `ALTER TABLE turn_blocks ADD COLUMN collapsed_content TEXT;`

Tool collapsed_content formats:
- text_editor read: `"[Read <path>: <chars> chars]"`
- text_editor edit: `"[Edited <path>: replaced N chars]"`
- doc_search: `"[Searched '<query>': <N> results]"`

collapsed_content is nullable — existing blocks keep NULL.

## Verification Criteria
- [ ] `make migrate-up` succeeds
- [ ] `make test` passes
- [ ] Tool execution stores collapsed_content
- [ ] collapsed_content is human-readable summary
- [ ] Existing tool results unchanged (nullable)
- [ ] `go vet ./...` clean
