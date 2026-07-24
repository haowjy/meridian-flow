# @meridian/agent-edit

Reusable Yjs agent-edit core: model-facing document read/write, response-scoped
commit buffering, write handles, and cold undo/redo over host-provided ports.
`write(command: "diff")` reads the current turn's folded trail through a
host-provided read-only query port.

## Mental model

Agent-edit edits a memory-only runtime Y.Doc. The host supplies durable journal
ports and live/branch coordinators; the package never owns Postgres, Hocuspocus,
routes, auth, or Meridian Work/Project concepts.

Runtime sync state is memory-only. The journal is the only durable record;
restart/cold paths reconstruct from retained updates/checkpoints. Attribution is
host-provided per interaction and must not depend on session-lifetime snapshots.

`ResponseCommitter` owns deferred response writes as an explicit durability
lifecycle: buffered updates become journal-committed before they are projected to
the live document. Recovery decisions follow that state, never an inferred catch
path. The committer owns one immutable snapshot and one promise while committing;
immediate writes use the journal kind returned by submission to restore or recover atomically.

## Rules

- Public mutations go through `write()` / `reverse()` / response lifecycle APIs.
- Do not bypass `ResponseCommitter` or infer durability from live projection; the
  journal boundary decides whether rollback may discard or must recover.
- Destructive policy is report-only: Yjs merge never blocks an agent write.
  Echo informs the agent; provenance-classified sweep trails inform the writer.
- Keep the kernel CRDT-neutral but be honest that v1 content currency is
  ProseMirror via `@meridian/markup`.
- Do not add draft-scope persistence, `scope_id`, or compatibility shims for the
  deleted draft subsystem.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
