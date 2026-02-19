---
detail: standard
audience: developer, architect
---
# Collaboration Spec: API and Event Contract

**Status:** Implemented (2026-02-19)
**Purpose:** Current runtime contract for Yjs transport, proposal lifecycle, and document sync.

## Architecture: Single WebSocket Per Project

> Current runtime uses `GET /ws/projects/{projectId}` for collaboration transport. Legacy `GET /ws/documents/{id}` is removed from runtime routing.

Everything runs over **one WebSocket connection per project** between the browser and the Go backend:

```
Browser <--> Go Backend (single WS per project)
  |-- JSON frames: doc:subscribe / doc:unsubscribe (document lifecycle)
  |-- Binary frames: Yjs sync protocol (document-multiplexed)
  |-- Binary frames: Yjs awareness protocol (document-multiplexed)
  |-- JSON frames: Application messages (proposals, heartbeat, errors)
```

No separate HTTP endpoints for proposal data. No separate Node service.

## WebSocket Protocol (Yjs)

The WebSocket protocol is based on the Yjs sync protocol (`y-protocols/sync`) and awareness protocol (`y-protocols/awareness`).

### Binary Message Types

Yjs sync uses a binary protocol with message types defined by `y-protocols`:

| Direction | Message | Purpose |
|---|---|---|
| Client -> Server | `sync step 1` | Send client state vector |
| Server -> Client | `sync step 2` | Send missing updates |
| Bidirectional | `update` | Incremental document update |
| Bidirectional | `awareness update` | Cursor/selection/presence state |

The Go server relays awareness updates between clients as opaque binary blobs — it doesn't need to understand the cursor data structure.

### Message Framing

WebSocket framing uses opcode first, then protocol-specific parsing:

| WS Frame Opcode | Payload | Handling |
|---|---|---|
| Text | Raw JWT string (first client message only) or JSON application message | Decode as UTF-8 text |
| Binary | Meridian envelope byte + 16-byte document UUID + Yjs protocol payload | Strip envelope+doc prefix, route by doc UUID, pass payload to Yjs protocol decoder |

Meridian uses a single-byte message-type prefix to multiplex sync and awareness on one WebSocket connection. This is a **custom envelope** — not the raw `y-protocols` wire format. The server strips this byte before passing the remainder to the underlying `y-protocols` decoders, and prepends it when sending.

> **Note:** `y-protocols/sync` internally uses its own first-byte scheme (`0x00`/`0x01`/`0x02` for sync step 1/step 2/update), and `y-protocols/awareness` uses its own `0x00`. The envelope byte below wraps these protocols so both can share a single binary WebSocket channel without ambiguity. The Yjs protocol bytes appear AFTER the Meridian envelope byte in the binary frame.

| Envelope Byte | Type |
|---|---|
| `0x00` (`messageYjsSyncStep1`) | Yjs sync step 1 |
| `0x01` (`messageYjsSyncStep2`) | Yjs sync step 2 |
| `0x02` (`messageYjsUpdate`) | Yjs incremental update |
| `0x03` (`messageAwareness`) | Yjs awareness update |

### Document-Multiplexed Binary Framing

Binary frames include a 16-byte document UUID for routing over the shared project connection:

```
[1B Meridian envelope][16B docID (UUID binary, big-endian)][N bytes Yjs protocol payload]
```

The envelope byte meanings are unchanged (see table above). The 16-byte UUID identifies which document the frame belongs to.

### Document Subscribe/Unsubscribe Protocol

```
Client → Server:
  { "type": "doc:subscribe", "documentId": "uuid" }
  { "type": "doc:unsubscribe", "documentId": "uuid" }

Server → Client:
  { "type": "doc:subscribed", "documentId": "uuid" }
  { "type": "doc:unsubscribed", "documentId": "uuid" }
  { "type": "doc:error", "documentId": "uuid", "code": "string", "message": "string" }
```

**Subscribe handshake sequence (strict order):**
1. Client sends `doc:subscribe`
2. Server validates ownership + project match
3. Server sends sync-step1 (multiplexed binary frame)
4. Server sends `proposal:snapshot` (JSON with `documentId`)
5. Server sends `doc:subscribed` (LAST — signals client to start sync)

**Idempotency:** Double-subscribe = no-op + re-send `doc:subscribed`. Unsubscribe for non-subscribed doc = no-op + send `doc:unsubscribed`.

**Reconnect:** Client maintains `activeSubscriptions` set and replays all subscriptions after re-auth on reconnect.

### Application-Level Messages (JSON text frames)

```typescript
// Server -> Client
{ type: "proposal:snapshot", documentId: string, proposals: Proposal[] }
{ type: "proposal:new", proposal: Proposal }  // Proposal already contains documentId
{ type: "proposal:statusChanged", documentId: string, proposalId: string, status: "accepted" | "rejected" }
{ type: "proposal:groupAcceptResult", documentId: string, outcomes: [{ proposalId: string, status: "accepted" | "skipped", error?: string }] }
{ type: "heartbeat" }
{ type: "readOnlyChanged", readOnly: boolean, reason: "permission_change" }  // Phase 5 only (viewer role)
{ type: "error", code: string, message: string }

// Client -> Server
{ type: "proposal:accept", documentId: string, proposalId: string, idempotencyKey: string }
{ type: "proposal:reject", documentId: string, proposalId: string }
{ type: "proposal:groupAccept", documentId: string, groupId: string, idempotencyKey: string }
{ type: "heartbeat" }
```

> **Note:** All document-scoped events and commands include `documentId` for routing over the multiplexed project WebSocket. `proposal:new` carries `documentId` inside the `Proposal` object. `proposal:snapshot` is scoped to a single document (sent per-document during subscribe handshake).

`proposal:snapshot` contract:
- Sent per-document after successful subscribe + Yjs sync-step1.
- Contains `documentId` and current pending proposals (`status='proposed'`) for that document.
- Snapshot proposals are metadata-only (`yjsUpdate` omitted to keep subscribe responses bounded).
- Incremental events (`proposal:new`, `proposal:statusChanged`) apply after this baseline snapshot.

### Proposal Type (WS JSON)

```typescript
interface Proposal {
  id: string;                          // UUID
  documentId: string;                  // UUID
  source: "ai" | "template" | "user_suggestion";
  producerAgentType: string;           // e.g., "editing_agent"
  threadId: string;                    // UUID
  turnId: string | null;               // UUID, nullable
  agentRunId: string;                  // UUID
  proposalGroupId: string | null;      // UUID, nullable
  status: "proposed";                  // always "proposed" in proposal:new/proposal:snapshot
  yjsUpdate?: string;                 // base64-encoded Yjs update buffer (included in proposal:new, omitted in proposal:snapshot)
  description: string | null;
  createdByUserId: string;
  createdAt: string;                   // ISO 8601 (e.g., "2026-01-15T10:30:00Z")
}
```

All dates in WS JSON use ISO 8601 format. All binary data (Yjs updates) uses base64 encoding.

### Heartbeat Contract

- Server sends `heartbeat` every 30s if no other traffic on the connection.
- Client must respond with `{ type: "heartbeat" }` within 5s, or server closes the connection.
- Client should consider the connection dead if no message (heartbeat or data) is received from the server for 60s.

### Protocol Notes

- Yjs sync protocol handles document state synchronization natively (no custom version tracking).
- Application-level JSON messages handle proposal lifecycle and session control.
- Clients must ignore unknown message types for forward compatibility.

## Session Handshake Contract (Required)

### Project WebSocket (Current Runtime)

1. Client opens WebSocket: `wss://<public-host>/ws/projects/{projectId}` (no auth in URL).
2. Client sends JWT token as the **first message** — a WebSocket **text frame** containing the raw JWT string (no JSON wrapper, no prefix).
3. Server validates JWT and extracts user ID. On failure: error message + close.
4. Connection is live — no documents subscribed yet.
5. Client sends `doc:subscribe` for each document to sync; server enforces ownership + project match per document (see subscribe handshake above).

```
Browser: WS upgrade (no auth in URL)
Browser -> Server: first message = JWT token
Server: validate JWT
Browser -> Server: { "type": "doc:subscribe", "documentId": "..." }
Server -> Browser: sync-step1 (multiplexed binary)
Server -> Browser: proposal:snapshot (JSON)
Server -> Browser: { "type": "doc:subscribed", "documentId": "..." }
Browser: runtime.startSync()
```

## Protocol Error Contract (v1)

| Code | Meaning | Client Behavior |
|---|---|---|
| `RESET_REQUIRED` | Yjs state corrupted or incompatible | Reload document, reconnect |
| `IDEMPOTENCY_REPLAY` | Same idempotency key already processed | Treat as success |
| `IDEMPOTENCY_KEY_CONFLICT` | Same idempotency key reused with different payload | Treat as hard error, generate new key |
| `PROPOSAL_NOT_FOUND` | Proposal ID does not exist in the database | Remove from local state |
| `PROPOSAL_INVALID_STATE` | Proposal is in a terminal state (`accepted` or `rejected`) and cannot transition | Refresh proposal status, show current state |
| `FORBIDDEN` | User is not allowed to access the requested document/action | Stop retrying this action, surface access error |
| `AUTH_FAILED` | JWT invalid, expired, or missing | Close connection, re-authenticate |
| `RATE_LIMITED` | Per-connection or per-doc limits exceeded | Exponential backoff (start 250ms, cap 5s) |

### Proposal Action Resolution Table

| Action | Proposal State | Result |
|---|---|---|
| accept | `proposed` | Normal accept flow |
| accept | `accepted` | `IDEMPOTENCY_REPLAY` (if same idempotency key) or `PROPOSAL_INVALID_STATE` (different key) |
| accept | `rejected` | `PROPOSAL_INVALID_STATE` |
| accept | not found | `PROPOSAL_NOT_FOUND` |
| reject | `proposed` | Normal reject flow |
| reject | `rejected` | Idempotent success (no error) |
| reject | `accepted` | `PROPOSAL_INVALID_STATE` |
| reject | not found | `PROPOSAL_NOT_FOUND` |

**WHY reject-on-rejected is idempotent success:** Reject has no idempotency key (it's a simple state transition with no side effects beyond marking the row). Repeating it is harmless and simplifies client retry logic. Accept-on-accepted requires the idempotency key check because accept has side effects (applying the Yjs update).

### Error Recovery: Corrupted Yjs State

If `Y.applyUpdate()` fails in Go (corrupted update from client or corrupted proposal):

1. **Client update corruption:** Log the error, send `RESET_REQUIRED` to the offending client. Other clients are unaffected.
2. **Proposal update corruption:** Quarantine the proposal (mark `status='rejected'`, set `description` to explain corruption). Do not apply to main doc. Broadcast `proposal:statusChanged` with `status: "rejected"`.
3. **Persisted state corruption:** On first-load failure, return `RESET_REQUIRED`. Server logs alert. Manual recovery required (restore from `collab_document_snapshots`).

All corruption events are logged at ERROR level with document ID and update metadata for investigation.

**Removed errors (vs previous drafts):**
- `VERSION_GAP` — Yjs state vectors handle sync gaps automatically.
- `LEASE_FENCED` — no lease fencing with CRDTs.
- `PROPOSAL_CONFLICTED` — no mechanical conflicts with CRDTs.
- `PAYLOAD_TOO_LARGE` — handled by admission limits, not a transport error.
- `TICKET_INVALID` — no ticket system; JWT-in-first-message replaces tickets.

## Reconnection Contract

- Initial delay: 250ms, max: 5s, formula: `min(5s, 250ms * 2^attempt) + jitter(15%)`.
- Reset attempt counter on successful connection (Yjs sync completes).
- `AUTH_FAILED`: re-authenticate (refresh JWT), then retry with backoff.
- All other disconnects: auto-retry with backoff.
- After successful reconnect + sync, server sends `proposal:snapshot` before incremental proposal events.

## Network Boundary and Routing Contract (Required)

All traffic goes through the **single Go backend**:

- `https://<public-host>/api/*` -> Go backend (public REST gateway)
- `wss://<public-host>/ws/*` -> Go backend (WebSocket endpoints)

No private service-to-service routes. No Node service.

Route ownership:
- Go handles all HTTP REST, WebSocket connections, Yjs persistence, and proposal mutations.
- Go uses `y-crdt` library for server-side Yjs operations.
- Active collab WS endpoint is `GET /ws/projects/{projectId}` only.
- `GET /ws/documents/{id}` is removed from runtime.

## Auth: JWT in First Message

- No ticket table, no ticket endpoint, no ticket TTL cleanup.
- Client sends JWT as the first message after WS upgrade.
- Server validates using existing JWT/JWKS infrastructure (same as REST API auth).
- On success: proceed with Yjs sync.
- On failure: send `{ type: "error", code: "AUTH_FAILED", message: "..." }` and close.

Read-only enforcement:
- Read-only sessions are Phase 5 only (viewer role via `permission_change`).
- In read-only mode, Yjs updates from the client are rejected.
- Read-only mode never blocks sync (client still receives updates).

## Proposal Lifecycle (Over WebSocket)

All proposal operations flow through the single WebSocket connection. No separate HTTP endpoints for proposals.

### Proposal Create

AI agents create proposals via internal Go service calls (not via WS from browser):
- Agent generates Yjs update buffer.
- Go service stores proposal row + broadcasts `proposal:new` to connected clients via WS.

### Proposal Accept (Client -> Server via WS)

```json
{ "type": "proposal:accept", "documentId": "uuid", "proposalId": "uuid", "idempotencyKey": "uuid" }
```

Server behavior:
1. Load Yjs update buffer from proposal row.
2. Apply `Y.applyUpdate(mainDoc, yjsUpdate)` — Yjs handles merge automatically.
3. Mark proposal row `status='accepted'` (terminal state, retained indefinitely as permanent audit record).
4. Broadcast Yjs update to connected clients (standard sync).
5. Broadcast `proposal:statusChanged` to connected clients.
6. Return ack or error via WS.

Accept idempotency:
- `idempotencyKey` in the WS message. Server validates format. Scoped to authenticated user, expires after 24 hours.
- Replayed accept returns stored response without side effects.
- Conflicting reuse returns `IDEMPOTENCY_KEY_CONFLICT` error.

### Proposal Reject (Client -> Server via WS)

```json
{ "type": "proposal:reject", "documentId": "uuid", "proposalId": "uuid" }
```

Server behavior:
- Mark proposal `rejected` (`decided_by_user_id` + `decided_at` set).
- Broadcast `proposal:statusChanged` to connected clients.
- If already rejected: idempotent success.
- If not found: `PROPOSAL_NOT_FOUND` error.

### Group Accept (Client -> Server via WS)

```json
{ "type": "proposal:groupAccept", "documentId": "uuid", "groupId": "uuid", "idempotencyKey": "uuid" }
```

Server behavior:
- Snapshot proposal set at transaction start (REPEATABLE READ or higher).
- Process proposals in deterministic order: `ORDER BY created_at ASC, id ASC`.
- Apply each Yjs update sequentially.
- Mark each proposal `status='accepted'`.
- Return per-proposal outcomes via WS: `{ type: "proposal:groupAcceptResult", outcomes: [{ proposalId, status: "accepted"|"skipped", error? }] }`.

### What This Eliminates

- HTTP proposal endpoints (`GET/POST /api/proposals/*`)
- Per-document collab websocket endpoint (`/ws/documents/{id}`)
- TanStack Query for proposal data (proposals come via WS)
- Go-to-Node forwarding for proposal mutations
- HMAC signing for internal service calls
- Two-phase staleness window between HTTP and WS data

### What HTTP REST Still Handles

- Non-realtime data: file tree, thread list, user settings
- Initial document metadata (`GET /api/documents/{id}`)
- Document CRUD operations
- Auth (JWT/JWKS validation is reused for WS)

## Accept/Reject Contract

Accept:
1. Load Yjs update buffer from proposal row.
2. Apply `Y.applyUpdate(mainDoc, yjsUpdate)` — Yjs handles merge automatically.
3. Mark proposal `status='accepted'` (terminal state, retained indefinitely).
4. Broadcast Yjs update + `proposal:statusChanged` to connected clients.
5. Return ack.

Reject:
- Mark proposal `rejected` and broadcast `proposal:statusChanged`.

Group-accept semantics:
- Snapshot proposal set at transaction start (REPEATABLE READ or higher).
- Proposals processed in deterministic order: `ORDER BY created_at ASC, id ASC`.
- Each proposal's Yjs update is applied sequentially via `Y.applyUpdate()`.
- Response returns per-proposal outcomes: `accepted | skipped`.
- Non-applicable errors (missing proposal, permission denied) produce `skipped` outcome with error detail.

Write-then-publish recovery:
- DB commit is authoritative; WS broadcast is best-effort delivery.
- If broadcast fails after commit, clients reconcile via Yjs sync protocol (automatic) on reconnect.

## Admission and Rate Contracts

| Limit | Default | Behavior on exceed |
|---|---|---|
| `max_yjs_update_bytes` | `256KB` | Reject proposal creation (server-side; proposals created via internal API, not WS frame) |
| per-op WS payload (client->server) | `64KB` | Reject, require smaller updates |

> **Note:** `max_yjs_update_bytes` applies to server-side proposal creation (internal API call), not to WS transport. Client WS frames are bound by the 64KB per-op limit. Proposals are broadcast to clients via `proposal:new` JSON frames which include the base64 `yjsUpdate` — these server->client frames are exempt from the 64KB client->server limit.
>
> **Known limitation:** `proposal:snapshot` is metadata-only (no `yjsUpdate` payloads). Snapshot is used as a baseline/status view; full Yjs update payloads are delivered in `proposal:new` events.

| Scope | Limit | Behavior |
|---|---|---|
| per WS connection inbound | `30` messages/sec | return `RATE_LIMITED`, temporary mute 1s |
| per document pending proposal accepts | `20` | reject new accepts until queue drains |
| per document queued agent proposals | `200` | reject lowest-priority new proposal |
| offline local queue (frontend) | `256KB` | stop queueing, show reconnect-required banner |

## Client Connection State Machine

```
disconnected -> connecting -> authenticating -> syncing -> synced
                                                           |
                                                       read_only
any state -> disconnected (on error/close)
```

Per-state rules:
- `disconnected`: no WS connection. Only valid action: initiate connect (with backoff if reconnecting).
- `connecting`: WS open in progress. No messages may be sent.
- `authenticating`: WS open, JWT sent as first message, awaiting validation response.
- `syncing`: JWT validated, Yjs sync protocol in progress. Document state being exchanged.
- `synced`: fully caught up. Normal editing allowed.
- `read_only`: session is read-only (Phase 5 permission model only — viewer role). Entered from `synced` via `readOnlyChanged` event with `reason: "permission_change"`.

## Key Casing Contract

- All WS JSON messages use camelCase keys (`proposalId`, `producerAgentType`).
- All SQL columns use snake_case (`proposal_id`, `producer_agent_type`).
- Adapter layer transforms automatically.

## Permission Contract

- v1 authorization is binary: authenticated user must pass `CanAccessDocument`.
- `owner`/`editor`/`viewer` split is a Phase 5 contract.

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
