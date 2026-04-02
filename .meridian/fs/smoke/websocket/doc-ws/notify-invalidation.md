# Notify Invalidation

The doc WS broadcasts lightweight notify events for proposal and document changes. These are always-on — no subscription required. The frontend maps them to TanStack Query `invalidateQueries` calls for reactive cache updates.

Notify payloads are small (max 1KB), idempotent, and safe to receive out-of-order or duplicated. They carry hints, not state — the client refetches from REST after invalidation.

## How to Reproduce

```bash
# 1. Connect to the doc WS (no subscription needed for notify)
./ws-client -token $ACCESS_TOKEN \
  -v \
  ws://localhost:$PORT/ws/projects/$PID/docs

# 2. In another terminal, create/accept/reject a proposal
curl -X POST http://localhost:$PORT/api/projects/$PID/documents/$DOC_ID/proposals \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "proposed edit..."}'

# 3. Accept the proposal
curl -X POST http://localhost:$PORT/api/proposals/$PROPOSAL_ID/accept \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**Expected output**:
```
-> sent auth
<- control:connected
<- notify:invalidate resource=proposal:<id> {"event":"created","documentId":"..."}
<- notify:invalidate resource=proposal:<id> {"event":"accepted","documentId":"..."}
```

**Document update notify** (triggers on any document content change):
```
<- notify:invalidate resource=document:<id> {"event":"updated"}
```

## Expected Behavior

1. Service layer calls `DocNotifier.NotifyProposal()` or `DocNotifier.NotifyDocument()`
2. `DocNotifier` wraps `Broadcaster.BroadcastNotify()` — sends to all project connections
3. Notify events have `kind: "notify"`, `op: "invalidate"`, `resource`, and `payload`
4. `payload.event` is one of: `created`, `accepted`, `rejected`, `updated`, `error`
5. `payload.version` (optional) enables client-side dedup
6. Frontend maps resource type + event → TanStack Query key invalidation

### Notify Events

| Event | Resource | When |
|---|---|---|
| `created` | `proposal` | New proposal created |
| `accepted` | `proposal` | Proposal accepted |
| `rejected` | `proposal` | Proposal rejected |
| `updated` | `document` | Document content changed |
| `error` | `document` | Document error |

## What Failure Looks Like

- **No notify events**: `DocNotifier` not wired or `BroadcastNotify` not calling `Session.Notify()` for each connection. Check domain wiring in `backend/internal/app/domains/collab.go`.
- **Notify arrives but TanStack cache doesn't update**: Frontend mapping from notify event → query key is wrong. Not a WS issue — check frontend integration.
- **Duplicate notifies**: Harmless by design. `invalidateQueries` is idempotent — extra refetches are acceptable.
- **Notify payload exceeds 1KB**: Framework enforces `defaultNotifyMaxBytes = 1024`. Oversized notify is rejected. Check what the service layer is putting in the payload.

## Related Code

- `backend/internal/handler/doc_ws_handler.go` — `DocHandler`, notify passthrough
- `backend/internal/handler/collab_proposal_broadcaster.go` — proposal notify emission
- `backend/internal/wsutil/ws.go` — `BroadcastNotify()`, `Session.Notify()`
- `backend/internal/app/domains/collab.go` — domain wiring, `DocNotifier` construction
