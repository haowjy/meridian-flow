# Thread control API

Both routes authenticate the writer and require ownership of the thread.
Controls are durable inbox entries, not chat text. `compact` and `handoff_brief` Retry are supported; undo is a separate checkpoint.
See [handoff creation and seed data](thread-handoff.md).

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
message, another control kind, or a row in another thread returns 409 (`control_id_conflict`).

`handoff_brief` Retry requires a handoff thread whose latest seed is `error` or
`cancelled`, and no pending brief control. Otherwise it returns 409
(`handoff_retry_unavailable`; `not_a_handoff_retry` for a non-handoff thread or
client-supplied seed pointer). Replaying the same matching id returns 200,
including after that Retry succeeds; it never queues another paid summary.

## Withdraw

`POST /api/threads/:threadId/controls/:controlId/withdraw`, no body.

```ts
{ outcome: "withdrawn" | "stopping" | "already_finished" }
```

Withdrawal acknowledges an unbound pending row. If a live run already bound
it as `controlMessageId`, withdrawal requests Stop for that run instead,
including when the receipt lease is overdue. The control is acknowledged in
the same transaction: a crashed owner cannot replay a withdrawn request.
A row-owned handoff seed ignores an expired receipt and settles directly.
An automatic compaction that absorbed it as `satisfiesControlId` returns
`already_finished`; its reply continues and C retires the control.
A finished or withdrawn row
returns `already_finished`. An unknown control returns 404
(`control_not_found`). Withdrawal and reservation share the thread lock, so
exactly one wins. Stop on a manual divider preserves unanswered messages adopted by the control;
the owner's post-release wake delivers them. Stop on an automatic compaction
retires its entire receipt, including any manual request it absorbed.

## CLI probe

Use the thread UUID, not its project-local handle, in the API path:

```sh
./mf api POST /api/threads/$THREAD_ID/controls \
  --data '{"id":"<uuid>","control":{"kind":"compact"}}'
./mf api POST /api/threads/$THREAD_ID/controls/$CONTROL_ID/withdraw
```

See `./mf api --help` for transport/auth options. The shared pending DTO is
specified in [the thread contracts](../../packages/contracts/src/threads/README.md).
