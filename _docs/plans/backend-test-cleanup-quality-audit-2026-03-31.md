**Status:** in progress

# Backend Test Cleanup Quality Audit

## Goal

Reduce redundant backend Go test code without changing test behavior or meaningful coverage.

## Scope

- Group 1: delete low-value tests called out by the audit
- Group 2: merge repeated tests into table-driven coverage
- Group 3: extract file-local shared construction helpers
- Group 4: split the `restore_service_test.go` mega-test into focused subtests
- Run `go test` after each group
- Commit after each verified group

## Notes

- Keep all high-value coverage intact; only remove trivial/demo/disposable tests
- Use descriptive `t.Run` names for all table-driven rewrites
- Keep helpers local to each test file
- The audit references two stale paths in the current tree:
  - `StateCheckVsGuard` now lives in `backend/internal/service/llm/streaming/executor_test.go`
  - The three `[unit-tester:dispose]` tests now live in `backend/internal/handler/collab_document_handler_broadcast_test.go`
