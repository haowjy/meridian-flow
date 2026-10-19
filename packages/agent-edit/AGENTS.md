# @meridian/agent-edit

Reusable Yjs editing core for model-facing document `read` and `write`,
response-scoped commit buffering, write handles, and forward inverses. Reads
and writes are separate entry points; every write command changes a document.

## Mental model

Agent-edit holds no document between calls. Every model call reads the room
fresh through `DocumentCoordinator.readRoom` (a disposable copy of what the
host holds, plus the edit scope's kept staged writes) and renders from it. A
write plans on the model's view (the frontier its request showed, plus the
reply's own updates), echoes on the room copy, and stages or commits its
captured update. The host supplies durable journal, coordinator, lifecycle,
link, and model ports; this package owns no Postgres, routes, auth, or
Meridian Project/Work concepts.

`ResponseCommitter` is the explicit response durability lifecycle: it stages
writes and accepts or rolls them back according to host settlement. The reply's
own accepted mutations live in `ReplyMutations`, which the host's reply owns and
passes in `WriteContext.frontiers.reply`: the committer appends a save's entries
there at its root commit, an inverse and an immediate write append their bytes,
and the reply clears it at its terminal boundary. No core, cache cap or LRU
holds them. Reporting is best-effort and
never mutates recovery state.

## Rules

- Public reads use `read()` and mutations use `write()` or response lifecycle
  APIs. The browser-safe `./yjs-mutation` subpath is only the host's pinned
  reconstruction adapter; it does not own persistence, attribution, or undo.
- Never bypass `ResponseCommitter` or infer durability from live projection.
  The journal boundary decides whether rollback discards or recovers.
- Yjs merge is trusted. Destructive policy is report-only; it never blocks an
  otherwise valid agent write. Echo reports best-effort direct-write
  destructive evidence, and that evidence never feeds draft-settlement sweep
  or apply authority.
- Attribution is host-provided per interaction and must not depend on
  session-lifetime snapshots.
- Keep the kernel CRDT-neutral while treating v1 content as ProseMirror via
  `@meridian/markup`.

See [contracts and architecture](.context/CONTEXT.md), which links the port,
write, invariant, link, and tool-surface references. Deferred work and rejected
alternatives are [TODO/FUTURE](.context/TODO.md) and [ALTERNATIVES](.context/ALTERNATIVES.md).
