# Phase 10: SSE + Legacy Cleanup

## Scope

Remove all SSE transport code and the old project WS now that both WS connections are proven end-to-end. This is the final phase — it only runs after both frontend providers are working.

Per [overview.md](../design/overview.md) §What Gets Removed:
- `SSEHandler` and `sse/` package
- `nethttp` adapter from mstream
- `StreamURL` remnants (should be gone from Phase 2, but verify)
- `AllowsSSE` helpers
- SSE `STREAM_SWITCH` event type
- Current project WS in `collab_project.go`
- `ProjectConnectionRegistry` and `ProjectBroadcaster` interfaces
- Frontend SSE transport code

## What's Out of Scope

- Document Yjs WS (stays as-is — completely separate concern)
- Deferred backlog items

## Prerequisites

- **Phase 8** (Frontend Doc WS working — old project WS no longer needed)
- **Phase 9** (Frontend Thread WS working — SSE no longer needed)

## Files to Delete

### Backend

| File | Reason |
|------|--------|
| `backend/internal/handler/sse_handler.go` | SSE streaming handler — replaced by Thread WS |
| `backend/internal/handler/sse/config.go` | SSE configuration |
| `backend/internal/handler/sse/keepalive.go` | SSE keepalive |
| `backend/internal/handler/sse/writer.go` | SSE event writer |
| `backend/internal/handler/collab_project.go` | Old project WS — replaced by Doc WS |
| `backend/internal/handler/project_connection_registry.go` | Old connection tracking — replaced by wsutil connection map |
| `backend/internal/handler/collab_proposal_broadcaster.go` | Old proposal broadcasting — replaced by DocNotifier (if not already removed in Phase 6) |
| `meridian-stream-go/adapters/nethttp/handler.go` | SSE HTTP adapter — no longer needed |
| `meridian-stream-go/handler.go` | SSE handler in mstream (if only used for SSE) |

### Frontend

| File/Code | Reason |
|-----------|--------|
| SSE `EventSource` usage in thread features | Replaced by ThreadWsProvider + StreamingChannelClient |
| `frontend-v2/src/features/threads/transport-types.ts` | SSE transport types (verify which types are SSE-specific vs shared) |
| `ThreadStoreInterface.connectStream()` / `disconnectStream()` | SSE-based stream connection |
| `STREAM_SWITCH` SSE event handling | Replaced by `ended{reason: stream_switch}` |
| Old project WS connection code | Replaced by DocWsProvider |

## Files to Modify

| File | Change |
|------|--------|
| `backend/internal/app/domains/llm.go` | Remove SSE route: `GET /api/turns/{id}/stream` → `SSEHandler.StreamTurn()`. Remove SSEHandler construction. |
| `backend/internal/app/domains/collab.go` | Remove old project WS route. Remove `ProjectConnectionRegistry` and `ProjectBroadcaster` construction (if not already removed in Phase 6). |
| `backend/internal/handler/thread.go` | Remove `AllowsSSE` helper references. Remove any SSE-related response construction. |
| `backend/internal/service/llm/streaming/agui/events.go` | Remove `StreamSwitchEvent` type (if still present — should be gone from Phase 2) |
| `backend/internal/handler/collab_message_loop.go` | Evaluate if still needed. If only used by old project WS and document WS, and document WS has migrated to wsutil, this may be deletable. If document Yjs WS still uses it, keep it. |
| `meridian-stream-go/` | Remove SSE-specific examples. Update README to reflect WS usage. |

## Cleanup Verification

Before deleting, verify no remaining references:

```bash
# Backend
grep -r "SSEHandler\|SSE_\|AllowsSSE\|StreamURL\|STREAM_SWITCH" backend/
grep -r "ProjectBroadcaster\|ProjectConnectionRegistry" backend/
grep -r "nethttp" meridian-stream-go/

# Frontend
grep -r "EventSource\|connectStream\|disconnectStream\|STREAM_SWITCH" frontend-v2/src/
grep -r "StreamURL\|streamUrl\|stream_url" frontend-v2/src/
```

## Patterns to Follow

- Delete confidently — this code has been replaced, not deprecated. No SSE fallback, no v1 compat (D21).
- Verify each deletion doesn't break imports in remaining code.

## Verification Criteria

- [ ] `go build ./backend/...` passes with no SSE-related code
- [ ] `go test ./backend/...` passes (all tests updated)
- [ ] `pnpm run lint` passes
- [ ] `pnpm tsc --noEmit` passes
- [ ] No `SSEHandler`, `AllowsSSE`, `StreamURL`, `STREAM_SWITCH`, `EventSource` references remain in codebase
- [ ] No `ProjectConnectionRegistry`, `ProjectBroadcaster` references remain
- [ ] Thread streaming works end-to-end via WS (smoke test)
- [ ] Document notifications work end-to-end via WS (smoke test)
- [ ] Document Yjs WS still works (unchanged)
- [ ] `go vet ./backend/...` passes

## Agent Staffing

- **Implementer**: `coder` (default codex — deletion-heavy, smoke-tester verifies nothing breaks)
- **Reviewers**: 1x completeness review (focus: nothing SSE-related survives; no dead imports)
- **Testing**: `smoke-tester` (full end-to-end: create thread → stream turn → interjection → spawn → doc notification — all via WS)
- **Verification**: `verifier`
