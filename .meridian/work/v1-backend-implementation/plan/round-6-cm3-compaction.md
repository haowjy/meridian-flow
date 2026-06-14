# Phase CM3: Compaction Service + MessageBuilder Bookmark Logic

## Scope
Create CompactionService for LLM-based summarization and update MessageBuilder to respect bookmark turns.

## Files to Create
- `backend/internal/service/llm/streaming/compaction_service.go`
- `backend/internal/service/llm/streaming/compaction_service_test.go`

## Files to Modify
- `backend/internal/domain/llm/message_builder.go` — respect bookmark turns

## Key Details
CompactionService: loads turns since last bookmark, sends to fast model (haiku-class) for summarization, creates compaction turn with summary.

MessageBuilder changes:
1. Find latest compaction turn → skip turns before it, use summary
2. Find collapse marker → for tool_result blocks before marker, use collapsed_content if available
3. No bookmarks → original behavior unchanged (regression safety)

## Verification Criteria
- [ ] Compaction creates summary turn
- [ ] No bookmarks = identical to current MessageBuilder (regression)
- [ ] Compaction turn → turns before it skipped, summary used
- [ ] Collapse marker → tool results use collapsed_content
- [ ] `make test` passes, `go vet ./...` clean
