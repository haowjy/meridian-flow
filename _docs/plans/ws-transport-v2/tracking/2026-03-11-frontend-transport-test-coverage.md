# Frontend Transport Test Coverage (2026-03-11)

## Scope
Add targeted frontend unit coverage for ws-transport-v2 behavior paths:
- `DocumentSessionManager` acquire/release/refcount, auth flow, reconnect reset, status transitions, and `AUTH_EXPIRED`.
- `CollabSyncRuntime` reset lifecycle and raw frame prefix protocol.
- `useProjectCollab` JSON-only handling, `doc:error` routing, `AUTH_EXPIRED`, and heartbeat ack behavior.

## Plan
1. Review the current ws-transport-v2 frontend tests and remove trivial placeholder coverage.
2. Extend the real transport/runtime test files with targeted assertions for the missing behavior paths.
3. Verify with:
   - `cd frontend && pnpm run test -- --run`
   - `cd frontend && pnpm run build`

## Notes
- This is a test-only frontend change.
- The task prompt is treated as approval for execution.
- New tests are marked `// [unit-tester:dispose]` unless a future orchestrator decides they should become permanent regression guards.
