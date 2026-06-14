# Runbook: editor collaboration and attribution

Verifies the active project page wires chat output into the live TipTap/Yjs
chapter editor and persists agent attribution.

## Preconditions

Run [`quick-chat-create.md`](quick-chat-create.md) and stay on
`/projects/{projectId}/agent`.

## Steps

### 1. Confirm editor subscription

```bash
playwright-cli expect '[data-testid="chapter-editor"]' visible
playwright-cli expect '[data-testid="yjs-status"]' text subscribed
```

**Expected:** the editor is contenteditable, contains `Chapter 1`, and the Yjs
status shows `subscribed`.

### 2. Send a unique message

```bash
export MSG="editor attribution smoke $(date +%s)"
playwright-cli fill '[data-testid="chat-composer"]' "$MSG"
playwright-cli click '[data-testid="send-message"]'
```

**Expected:** the latest assistant turn contains `Acknowledged: $MSG`, the editor
also contains `Acknowledged: $MSG`, and `[data-testid="editor-attribution"]`
shows agent-origin metadata.

### 3. Verify persistence

```bash
psql "$DATABASE_URL" -c "select document_id, length(update_data), origin_type, actor_turn_id from document_yjs_updates order by created_at desc limit 5;"
```

**Pass:** Yjs update rows increase after the send, markdown projection includes
the assistant text, and the latest update has `origin_type = agent` with `actor_turn_id` pointing at the assistant turn.

**Fail:** editor does not update, attribution is missing, or Yjs persistence does
not record the change.
