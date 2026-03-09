# Goal

Verify a single client can connect via WebSocket, subscribe to a document,
send a text edit, and read it back after reconnect.

# Prerequisites

- Running dev server at `$BASE_URL` (default `http://localhost:8080`)
- Valid `ACCESS_TOKEN` in root `.env` (run `./scripts/get-token.sh`)
- `websocat` or Go probe available

# Setup

1. Create a test project:
   ```bash
   curl -s -X POST $BASE_URL/api/projects \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"name":"smoke-test-'$(date +%s)'"}' | jq .
   ```
   Save `project_id`.

2. Create a test document in that project:
   ```bash
   curl -s -X POST $BASE_URL/api/documents \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"title":"smoke-doc","content":"","project_id":"'$PROJECT_ID'","type":"md"}' | jq .
   ```
   Save `document_id`.

# Probes

1. **Connect + auth**: Open WS to `/ws/projects/$PROJECT_ID`, send JWT as first message.
   - Expect: JSON `{"type":"project:connected",...}` within 2s.

2. **Subscribe**: Send `{"type":"doc:subscribe","documentId":"$DOC_ID"}`.
   - Expect: Binary SyncStep1 frame (first byte `0x00`, next 16 bytes = doc UUID).
   - Expect: JSON `{"type":"doc:subscribed",...}` after sync completes.

3. **Send update**: Construct a Yjs update that inserts "hello smoke test" into Y.Text("content"). Send as binary Update envelope (type byte `0x02` + doc UUID + payload).
   - Expect: No error. Connection stays open.

4. **Disconnect + reconnect**: Close WS cleanly. Wait 3s (for debounce persist). Reconnect, re-auth, re-subscribe.
   - Expect: SyncStep2 contains the "hello smoke test" content.

5. **Verify via REST**: `GET /api/documents/$DOC_ID`.
   - Expect: `content` field contains "hello smoke test".

# Invariants

- No WebSocket errors or unexpected close codes at any point.
- Document content after reconnect matches what was sent.
- Server health endpoint returns 200 throughout.

# Teardown

```bash
curl -s -X DELETE $BASE_URL/api/projects/$PROJECT_ID \
  -H "Authorization: Bearer $TOKEN"
```

# Report Format

| Probe | Status | Evidence |
|-------|--------|----------|
| 1. Connect + auth | PASS/FAIL | response JSON or error |
| 2. Subscribe | PASS/FAIL | frame bytes or timeout |
| 3. Send update | PASS/FAIL | connection state |
| 4. Reconnect + verify | PASS/FAIL | synced content |
| 5. REST verify | PASS/FAIL | GET response body |
