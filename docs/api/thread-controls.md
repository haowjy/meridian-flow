# Thread control API

Both routes authenticate the writer and require ownership of the thread.
Controls are durable inbox commands, not chat text. The kinds are `compact` and
`write_mode` (the chat's write-mode switch). Handoff Stop and Retry act on
handoff seed turns through the [handoff API](thread-handoff.md), not through
controls. Scheduling (when a control runs, applies or yields) is owned by the
[runtime controls context](../../apps/server/server/domains/runtime/.context/controls.md).

## Enqueue

`POST /api/threads/:threadId/controls`

```json
{ "id": "client-minted-uuid", "control": { "kind": "compact", "instructions": "Preserve the villain’s promises." } }
{ "id": "client-minted-uuid", "control": { "kind": "write_mode", "mode": "draft" } }
```

Returns 201 for a new row or 200 for an existing id:

```ts
{
  id: string;
  queued: boolean;              // this control is still pending
  pending: PendingInboxItem | null; // the chat's queued switch, not necessarily this request's row
  turnId: string | null;
  seq: string;                  // journal head at the read
  mode: "draft" | "direct";     // the chat's applied write mode
}
```

`queued`, `pending`, `mode` and `seq` are read in one transaction under the
thread lock after the write, `seq` last
([switch clock](../../packages/contracts/src/threads/README.md#switch-clock)).

Compact instructions are trimmed, limited like writer-message text, and an
empty value is omitted. A queued row carries its full control body in
`pending.control`. Once executed, its turn carries `metadata.controlMessageId`
and the answer returns that turn id.

A write-mode switch stays `queued` with `turnId` null until a run is admitted,
in an idle chat as in a running one; it applies at that run's start (see the
runtime context). A switch back, or a Withdraw, cancels it: `queued` false and
`turnId` null. A replay after application returns the switch turn's id. A
withdrawn row keeps its key retired: retrying enqueue never schedules a
withdrawn or completed control.

`/compact` requires at least one completed assistant reply in the effective
transcript, including inherited fork history; otherwise enqueue returns 409
(`compact_requires_completed_reply`). The domain checks this while holding the
thread lock. Every accepted manual compact produces a summary, including
consecutive commands and short histories.

Invalid bodies return 400 (`invalid_control`). An id belonging to an ordinary
message, another control kind, or a row in another thread returns 409
(`control_id_conflict`); so does replaying an id with a different body.

The `Thread` shape served by the project thread list and the thread reads carries
`effectiveAiWriteMode`: the queued switch's mode while one is pending, else the
applied `aiWriteMode`. It is read in the same query as the row. Clients show it
until the snapshot's switch record arrives.

## Withdraw

`POST /api/threads/:threadId/controls/:controlId/withdraw`, no body.

```ts
{ outcome: "withdrawn" | "already_started", queued: boolean, pending: PendingInboxItem | null, mode: "draft" | "direct", seq: string }
```

`queued` is false after either outcome. `pending`, `mode` and `seq` mean what
they do in the enqueue answer, read after the acknowledgment.

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
