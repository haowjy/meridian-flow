# Thread control API

Both routes authenticate the writer and require ownership of the thread.
Controls are durable inbox commands, not chat text. The supported kind is `compact`; handoff Stop and Retry act on handoff seed turns
through the [handoff API](thread-handoff.md), not through controls.

## Enqueue

`POST /api/threads/:threadId/controls`

```json
{ "id": "client-minted-uuid", "control": { "kind": "compact" } }
```

Returns 201 for a new row or 200 for an existing id:

```ts
{ id: string; pending: PendingInboxItem | null; turnId: string | null }
```

A queued row carries its control body in `pending.control`. Once executed, its
turn carries `metadata.controlMessageId`. Completed controls return their turn
id. A withdrawn row returns both `pending` and `turnId` null. Its key stays
retired: retrying enqueue never schedules a withdrawn or completed control.

Commands run only at run start, at most one per run. Waiting messages take
priority; Stop stamps pending controls so the oldest stamped command runs first
with the waiting messages. A command is acknowledged by the commit that starts
it. A pending command never blocks a reply or runs at a tool boundary.

Invalid bodies return 400 (`invalid_control`). An id belonging to an ordinary
message, another control kind, or a row in another thread returns 409
(`control_id_conflict`).

## Withdraw

`POST /api/threads/:threadId/controls/:controlId/withdraw`, no body.

```ts
{ outcome: "withdrawn" | "already_started" }
```

Withdrawal acknowledges a command that has not started. If its C already records the command id, withdrawal returns `already_started` and does not stop
the run. Replaying withdrawal of a withdrawn row still returns `withdrawn`.
An unknown control returns 404 (`control_not_found`). Withdrawal and start
reservation share the thread lock, so exactly one wins.

## CLI probe

Use the thread UUID, not its project-local handle, in the API path:

```sh
./mf api POST /api/threads/$THREAD_ID/controls \
  --data '{"id":"<uuid>","control":{"kind":"compact"}}'
./mf api POST /api/threads/$THREAD_ID/controls/$CONTROL_ID/withdraw
```

See `./mf api --help` for transport/auth options. The shared pending DTO is
specified in [the thread contracts](../../packages/contracts/src/threads/README.md).
