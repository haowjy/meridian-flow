# @meridian/agent-edit

Reusable Yjs editing core for model-facing document `read` and `write`,
response-scoped commit buffering, write handles, and forward inverses. Reads
and writes are separate entry points; every write command changes a document.

## Mental model

Agent-edit owns a memory-only runtime Y.Doc. The host supplies durable journal,
coordinator, lifecycle, link, and model ports; this package owns no Postgres,
routes, auth, or Meridian Project/Work concepts. Runtime state is rebuilt from
host-retained updates and checkpoints.

`ResponseCommitter` is the explicit response durability lifecycle: it stages
writes, accepts or rolls them back according to host settlement, and owns
private draft helpers. A prepared read is a disposable lease. Reporting is
best-effort and never mutates recovery state.

## Rules

- Public reads use `read()` and mutations use `write()` or response lifecycle
  APIs. The browser-safe `./yjs-mutation` subpath is only the host's pinned
  reconstruction adapter; it does not own persistence, attribution, or inverse orchestration.
- `./diff` is the pure review model shared by browser, server and migration:
  `blocksEqual` decides `has_effect`, `projectReview` produces the changes,
  `composeGroups` builds the Apply and local Discard patches, and `rebase`
  merges live into a draft. Never reimplement any of them beside it: two
  copies of "what changed" disagree. See [`.context/diff-review.md`](.context/diff-review.md).
- Never bypass `ResponseCommitter` or infer durability from live projection.
  The journal boundary decides whether rollback discards or recovers.
- Yjs merge is trusted. Destructive policy is report-only; it never blocks an
  otherwise valid agent write. Echo reports best-effort direct-write
  destructive evidence, and that evidence never feeds branch-settlement sweep
  or apply authority.
- Attribution is host-provided per interaction and must not depend on
  session-lifetime snapshots.
- Keep the kernel CRDT-neutral while treating v1 content as ProseMirror via
  `@meridian/markup`.

See [contracts and architecture](.context/CONTEXT.md), which links the port,
write, invariant, link, and tool-surface references. Deferred work and rejected
alternatives are [TODO/FUTURE](.context/TODO.md) and [ALTERNATIVES](.context/ALTERNATIVES.md).
