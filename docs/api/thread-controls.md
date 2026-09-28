# Thread control API

Both routes authenticate the writer and require ownership of the thread.
Controls are durable inbox entries, not chat text. Only `compact` is supported;
undo and handoff commands are separate checkpoints.

## Enqueue

`POST /api/threads/:threadId/controls`

```json
{ "id": "client-minted-uuid", "control": { "kind": "compact" } }
```

Returns 201 for a new row or 200 for an existing id:

```ts
{ id: string; pending: PendingInboxItem | null; turnId: string | null }
```

A queued row has `pending.control.kind: "compact"`. Once reserved, its turn
carries `metadata.controlMessageId`; an automatic compaction satisfying the
request carries `satisfiesControlId` instead. Completed controls return their
turn id. A withdrawn row returns both `pending` and `turnId` null. Its key stays
retired: retrying enqueue never schedules a withdrawn or completed control.
A crash may retry an unacknowledged control on a new divider.

Invalid bodies return 400 (`invalid_control`). An id belonging to an ordinary
message returns 409 (`control_id_conflict`).

## Withdraw

`POST /api/threads/:threadId/controls/:controlId/withdraw`, no body.

```ts
{ outcome: "withdrawn" | "stopping" | "already_finished" }
```

Withdrawal acknowledges an unbound pending row. If a live run already bound
it, withdrawal requests Stop for that run instead. A finished or withdrawn row
returns `already_finished`. An unknown control returns 404
(`control_not_found`). Withdrawal and reservation share the thread lock, so
exactly one wins. Stop preserves unanswered messages adopted by the control;
the owner's post-release wake delivers them.

## CLI probe

Use the thread UUID, not its project-local handle, in the API path:

```sh
./mf api POST /api/threads/$THREAD_ID/controls \
  --data '{"id":"<uuid>","control":{"kind":"compact"}}'
./mf api POST /api/threads/$THREAD_ID/controls/$CONTROL_ID/withdraw
```

See `./mf api --help` for transport/auth options. The shared pending DTO is
specified in [the thread contracts](../../packages/contracts/src/threads/README.md).
