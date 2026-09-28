# Thread control API

Both routes authenticate the writer and require ownership of the thread.
Controls are durable inbox commands, not chat text. The supported kinds are
`compact` and `compaction_undo`; handoff Stop and Retry act on handoff seed turns
through the [handoff API](thread-handoff.md), not through controls.

## Enqueue

`POST /api/threads/:threadId/controls`

```json
{ "id": "client-minted-uuid", "control": { "kind": "compact" } }
```

Undo names a local compaction turn (pending is allowed at enqueue):

```json
{ "id": "client-minted-uuid", "control": { "kind": "compaction_undo", "compactionTurnId": "compaction-turn-uuid" } }
```

A missing, inherited or non-compaction target returns 404
(`compaction_not_found`). Active-target and size checks happen at execution.
A refusal appends an empty system marker with a typed `metadata.reason` and
writer-facing error. Successful undo restores pre-cut history under the
pre-compaction bake. It is refused if the restored request reaches the current
Agent trigger and makes no model call.

Returns 201 for a new row or 200 for an existing id:

```ts
{ id: string; pending: PendingInboxItem | null; turnId: string | null }
```

A queued row carries its control body in `pending.control`. Once executed, its
turn carries `metadata.controlMessageId`; an automatic compaction satisfying a
`compact` request carries `satisfiesControlId`. Completed controls return their
turn id. A withdrawn row returns both `pending` and `turnId` null. Its key stays
retired: retrying enqueue never schedules a withdrawn or completed control.

Invalid bodies return 400 (`invalid_control`). An id belonging to an ordinary
message, another control kind, or a row in another thread returns 409
(`control_id_conflict`).

## Withdraw

`POST /api/threads/:threadId/controls/:controlId/withdraw`, no body.

```ts
{ outcome: "withdrawn" | "stopping" | "already_finished" }
```

Withdrawal acknowledges an unbound pending row. If a live run already bound
it, withdrawal requests Stop for that run, including when the receipt lease is
overdue. A finished or withdrawn row returns `already_finished`. An unknown
control returns 404 (`control_not_found`). Withdrawal and reservation share the
thread lock, so exactly one wins.

## CLI probe

Use the thread UUID, not its project-local handle, in the API path:

```sh
./mf api POST /api/threads/$THREAD_ID/controls \
  --data '{"id":"<uuid>","control":{"kind":"compact"}}'
./mf api POST /api/threads/$THREAD_ID/controls/$CONTROL_ID/withdraw
```

See `./mf api --help` for transport/auth options. The shared pending DTO is
specified in [the thread contracts](../../packages/contracts/src/threads/README.md).
