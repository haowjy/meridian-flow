# @meridian/agent-edit

Reusable Yjs agent-edit core: model-facing document `read` and `write`,
response-scoped commit buffering, write handles, and cold undo/redo over
host-provided ports. `read()` and `write()` are separate entry points; every
`write` command changes a document.

## Mental model

Agent-edit edits a memory-only runtime Y.Doc. The host supplies durable journal
ports and live/branch coordinators; the package never owns Postgres, Hocuspocus,
routes, auth, or Meridian Work/Project concepts. The coordinator's document is
this core's canonical world; it need not be the host's live document.

Runtime sync state is memory-only. The host persists journals and immutable edit
receipts;
restart/cold paths reconstruct from retained updates/checkpoints. Attribution is
host-provided per interaction and must not depend on session-lifetime snapshots.

`ResponseCommitter` owns deferred response writes as an explicit durability
lifecycle: journal submission precedes coordinator projection, but submission can
be host-staged rather than durable. Finalization follows the host transaction;
recovery follows the explicit acceptance state, never an inferred catch path.
Draft response helpers are private committer-owned Y.Docs, never runtime-store
entries. Core `prepare` returns a disposable read lease; only tool results drain
the dropped-write notice outbox. Whole Discard advances a document epoch, revoking
its outstanding leases without closing independent documents in the same reply.
Replay acceptance and staging both validate that lifetime. Equivalent prepares
retain their view identity; real content/cut changes invalidate concurrent replay.
Save-time link preparation receives only disposable replicas.
Rollback changes ownership only on settlement.
The committer owns one immutable snapshot and one promise while committing;
immediate writes use the journal kind returned by submission to restore or recover atomically.
Receipts render accepted cuts independently of projection. Reporting failures produce
degraded receipts, never mutation recovery; prepared reporting uses the owner’s accepted
before and after cuts without acquiring or applying to a live document.

## Rules

- Public reads go through `read()`; mutations go through `write()` / `reverse()` /
  response lifecycle APIs. The narrow browser-safe `./yjs-mutation` subpath is
  the pinned private-Yjs adapter for host-owned reconstruction transactions; it
  does not own retirement policy, persistence, attribution or undo orchestration.
- Do not bypass `ResponseCommitter` or infer durability from live projection; the
  journal boundary decides whether rollback may discard or must recover.
- Destructive policy is report-only: Yjs merge never blocks an agent write.
  Echo reports best-effort direct-write destructive evidence. That evidence never
  feeds branch-settlement sweep or apply authority.
- Keep the kernel CRDT-neutral but be honest that v1 content currency is
  ProseMirror via `@meridian/markup`.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)

## Forward inverse primitive (parallel, not policy)

`undo/forward-inverse.ts` owns receipt normalization, per-part classification,
restoration lineage, and admission. The browser-safe `yjs-mutation.ts` owns
retained-struct lookup, visibility, splitting, redone hydration/capture and
low-level UndoManager execution, pinned to Yjs 13.6.31. `computeInverse` returns one edit
per target edit, with transaction-delta parts and aliases; the host persists
those edits under one action ID. Normalization is per edit, never per action.
This primitive does not route commands, choose destinations, or choose a destination. The server now uses it for receipt actions and
failed-response rollback; model undo/redo still runs on the old engine.
