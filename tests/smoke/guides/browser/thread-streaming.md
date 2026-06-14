# Runbook: thread streaming

Verifies the project agent composer sends through `POST /api/threads/:id/messages`,
the copied runtime orchestrator streams over `/api/threads/ws`, and the turn rows
settle in Postgres.

## Preconditions

Run [`quick-chat-create.md`](quick-chat-create.md) and stay on
`/projects/{projectId}/agent`.

## Steps

### 1. Send a unique message

```bash
export MSG="browser smoke $(date +%s)"
playwright-cli fill '[data-testid="chat-composer"]' "$MSG"
playwright-cli click '[data-testid="send-message"]'
```

**Expected:** a new assistant turn appears, streams text, and its state settles to
`finished`. Browser console has no thread WebSocket errors.

### 2. Verify database state

Find the active thread id from the DOM (`data-turn-id` on the latest assistant
turn can identify the turn), or query newest rows:

```bash
psql "$DATABASE_URL" -c "select id, role, status, completed_at from turns order by created_at desc limit 4;"
psql "$DATABASE_URL" -c "select event_type, count(*) from event_journal group by event_type order by event_type;"
```

**Pass:** there is a complete user turn, a complete assistant turn, and journal
rows include `turn.created`, `stream.delta`, `model.response_received`,
`block.upserted`, `usage`, and `turn.completed`.

**Fail:** assistant stays pending/streaming, journal lacks terminal events, or
browser console shows unhandled stream/WS errors.
