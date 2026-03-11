# Project-Scoped WebSocket Protocol Spec

## Endpoint
`GET /ws/projects/{projectId}` — single WS per project, multiplexes documents.

Old endpoint `/ws/documents/{id}` is REMOVED.

## Connection Lifecycle

1. **Dial** `ws://host/ws/projects/{projectId}`
2. **Auth**: Send JWT as first text message
3. **Ack**: Server responds with JSON `{"type":"project:connected"}`
4. **Heartbeat**: Server sends `{"type":"heartbeat"}` every 30s; client must ack with any JSON containing `"type":"heartbeat"` within 5s
5. **Auth timeout**: 5 seconds. No JWT → server closes.
6. **Rate limit**: 30 msgs/sec. Exceeded → 1s mute.

## Document Subscription

### Subscribe
Send JSON: `{"type":"doc:subscribe","documentId":"<uuid>"}`

Server responds with (in order):
1. Binary SyncStep1 frame (17-byte header)
2. JSON `{"type":"proposal:snapshot","documentId":"...","proposals":[...]}`
3. JSON `{"type":"doc:subscribed","documentId":"..."}`

### Unsubscribe
Send JSON: `{"type":"doc:unsubscribe","documentId":"<uuid>"}`
Response: `{"type":"doc:unsubscribed","documentId":"...","reason":null}`

### Doc-scoped errors (do NOT close WS)
`{"type":"doc:error","documentId":"...","code":"...","message":"..."}`
Codes: `INVALID_DOCUMENT_ID`, `DOCUMENT_NOT_FOUND`, `SUBSCRIPTION_LIMIT` (max 10), `NOT_SUBSCRIBED`

## Binary Envelope Format (17-byte header)

```
[Byte 0: Type] [Bytes 1-16: Document UUID (16 raw bytes)] [Bytes 17+: Yjs payload]
```

Types:
- 0x00 = SyncStep1
- 0x01 = SyncStep2
- 0x02 = Update
- 0x03 = Awareness

The Document UUID is the raw 16-byte UUID (not hex-encoded). Parse from string with `uuid.Parse(docId)` which returns `[16]byte`.

## Proposal Commands (JSON over WS)

### Accept
```json
{"type":"proposal:accept","documentId":"<uuid>","proposalId":"<uuid>","idempotencyKey":"<string>"}
```
On success: broadcasts binary Update frame + JSON `{"type":"proposal:statusChanged","documentId":"...","proposalId":"...","status":"accepted"}`

### Reject
```json
{"type":"proposal:reject","documentId":"<uuid>","proposalId":"<uuid>"}
```
On success: broadcasts `{"type":"proposal:statusChanged","documentId":"...","proposalId":"...","status":"rejected"}`

### Errors
Codes: `PROPOSAL_NOT_FOUND`, `PROPOSAL_INVALID_STATE`, `IDEMPOTENCY_KEY_CONFLICT`, `FORBIDDEN`, `RATE_LIMITED`

## Snapshot REST API

- `POST /api/documents/{id}/snapshots` — body: `{"name":"..."}` → 201
- `GET /api/documents/{id}/snapshots?limit=50&offset=0` → 200 `{"snapshots":[...],"total":N}`
- `GET /api/documents/{id}/snapshots/{sid}/content` → 200 `{"content":"..."}`
- `POST /api/documents/{id}/snapshots/{sid}/restore` → 200 `{"status":"restored",...}`
- `DELETE /api/documents/{id}/snapshots/{sid}` → 204

## Constants
- Auth timeout: 5s
- Max payload: 64KB
- Heartbeat interval: 30s
- Heartbeat ack timeout: 5s
- Rate limit: 30 msgs/sec
- Max subscriptions: 10 docs/conn
- Persist debounce: 2s
- Auto-snapshot: every 500 updates
- Max proposal size: 256KB
- Idempotency TTL: 24h
- Max queued proposals: 200/doc
- Max pending accepts: 20/doc

## Smoke Test Pattern

Each probe: `bash smoke.sh` → sources `helpers.sh` → `go run probe.go --flags`
- helpers.sh provides: `BASE_URL`, `WS_ORIGIN`, `TOKEN`, `status_code()`, `assert_status()`, `create_temp_project()`, `create_temp_document()`, cleanup trap
- probe.go: standalone `package main`, imports from backend go.mod (run via `cd backend && go run`)
- Output: `[probe] PASS: ...` or `[probe] FAIL: ...`
- smoke.sh output: `[smoke] PASS: ...` or `[smoke] FAIL: ...`
- Exit code: 0 pass, 1 fail
