# Collab — reversal

## Undo guard and push safety

`reverseThreadContext` is the route-facing reversal command. It owns the choice
between context-document and turn-lineage reversal, write-handle parsing,
projection refresh, and aggregate result status; the HTTP route only authenticates,
validates its transport body, invokes the command, and serializes the result.
For compatibility, a top-level array, primitive, or `null` body is normalized
to `{}` before validation and returns `400 direction must be undo or redo`.
`TurnReversalServiceDeps` is total: each composition supplies its dependencies
or the declared unsupported stubs; do not restore optional dependencies that
fail only when a command reaches them.

Context-document reversal adopts the context resolver's successful canonical
URI together with its document ID. The request URI is syntax to resolve, never
stable reversal-result identity.

- **Live receipt reversal state uses the command planner**:
  `drizzle-turn-receipt.ts` asks agent-edit `planUndo` and `planRedo` for each
  live document instead of projecting availability from mutation status.
  Command execution uses the same planners. The planner rejects redo after a
  later writer (`human:*`) row but ignores the undo's system row, other system
  bookkeeping, and later agent rows. Persist-time guards repeat the writer-only
  watermark check under the document lock, covering a writer admission between
  planning and persistence. Active Work-draft receipt and command paths both use
  `branch-turn-reversal-plan.ts`; its authority is branch generation, journal
  status, dependency analysis, and successful peer reconstruction. Undo treats
  both `active` and `rollback_pending` rows as current effects; redo rebuilds
  from active survivors plus only the selected discarded target.
- **Receipt command unavailable states are semantic outcomes**: the reverse endpoint may
  return `nothing_to_undo`, `nothing_to_redo`, `cant_undo_dependent`, `expired`,
  or `partial` with HTTP 200 when state races the projection. The app invalidates
  the turn query after the command and retains the raced reason while the receipt
  changes to its unavailable state; callers must not discard these outcomes.
- **Canonical reversal is live-scoped**: hosted `reverse()` uses the live utility
  core, never the thread-peer branch committer. The host captures a live Yjs
  snapshot and live-journal sequence together before entering agent-edit.
- **Model undo and redo reverse each write where it landed**:
  `thread-peer-reversals.ts` loads both histories once, `splitReversal`
  (`reversal-routing.ts`) reads which selected
  handles sit in the thread's Work-draft rows and which in the live journal,
  and runs the selection once per journal with that journal's share (`last: N`
  counts per journal). Each part carries a grant at its own destination, so a
  drafted write in an archived Work is refused with `work_archived` while live
  parts of the same call still reverse; `mergeReversals` makes a mixed result
  `partial` and names the kept handles.
- **Creates, moves and deletes are write handles too** (D66):
  `agent_namespace_changes` holds the model's live creates (a `create` or
  `copy` shares its content write's handle), moves and deletes, on the
  document's `w_id` counter (`adapters/write-ordinals.ts`) shared with content
  writes, and records the draft branch each landed in (null for live).
  `domain/namespace-reversal.ts` plans the model's walk over both kinds,
  drafted content handles included, and executes it, reversing each change
  where it landed, under a grant there, whatever the thread's mode is now.
  `lib/model-tools/namespace-reversal.ts` only resolves the path, binds
  grants and content reversal as ports, and formats the outcome.
- **Namespace dependencies are per document and per thread**:
  `namespaceReversalEligibility` is the one rule. Undo is blocked by this
  thread's later active namespace change on the document (A→B→C: undoing
  A→B waits until B→C is undone), and undoing a create by any later content
  write not reversed in the same command. Redo is blocked by an earlier
  change still undone and by a later change now active. Changes by the
  writer or another thread are not dependencies; they surface at apply time
  as `location_taken` or `stale_location`. The model walk, turn preflight
  (`turnNamespaceEligibility`) and the turn receipt's Undo/Redo projection
  all call it, so the receipt never offers what the command refuses.
- **One reversal step for a create, move or delete**:
  `createNamespaceChanges` (`domain/namespace-changes.ts`) claims the row,
  changes the tree and flips its status in one transaction, and `commit`
  records a new change in the transaction that makes it. The model's `undo`
  and `redo`, reply rollback, the writer's restore of a delete
  (`POST …/turns/:turnId/restore-delete`) and turn undo all take it. Rollback
  tries every change of the reply, logs `response_rollback.failed` for one
  that stays, and forgets every handle of the reply.
- **Links settle before every namespace transaction**: a model move, and
  `reverse` for a move (model undo/redo, reply rollback), flush link
  derivations before `atomic(...)`, so no connection is held across the
  flush. Turn undo flushes once for the whole turn and passes the settled
  tree, on which a repeat settle is a no-op. Inside, the
  turn takes its tree locks first, then reverses the changes that leave the
  document in place, then content, then the ones that remove it (an undone
  create, a redone delete), keeping the seam's namespace-then-document order.
  A refused change is `location_taken`, `folder_missing`,
  `permission_denied` or `cant_undo_dependent`.
- **Work-draft write-command reversal is branch-scoped**: for the drafted part of
  a selection, `write(command="undo"|"redo")`
  reconstructs and stages reversals exclusively from those rows. The staged
  system row carries the Work-draft generation and becomes durable in the same
  branch commit that projects its Yjs update; it never writes the live journal.
  The command pins one branch scope from planning through persistence, and cold
  replay is reconciled to the authoritative branch snapshot.
  The commit also checks the planned branch-journal watermark and status revision
  under the branch snapshot CAS, so appended rows and status-only Apply/review
  transitions both reject the stale reversal for replanning.
  After Apply advances to an empty generation, reversal lookup falls back to the
  live store so pushed writes retain their normal undo path.
- **Turn reversal is durable-atomic and runtime-staged**: production persists
  branch and live changes in one ambient Drizzle transaction. Across distinct
  documents, a no-op or unavailable result mixed with success makes the aggregate partial
  and aborts the whole transaction. Duplicate branch/live results for the same
  document are folded first, so one successful scope plus its no-op peer remains
  successful. Branch broadcasts, live Y.Doc application, runtime synchronization,
  and projection refresh run only after commit, with per-document journal
  recovery; rollback publishes none of them. Cross-room publication is
  serialized, not a simultaneous transport primitive. Branch candidates are
  restricted to the command's authorized document set.
- **Work-draft handles name durable response groups**: response buffering and branch
  projection fold all same-document mutations in one response into one
  `branch_write_journal` row. Every write in that group therefore receives the
  same `w<N>` handle. Selectors operate on durable rows, not transient tool-call
  boundaries; redo may further group handles that share one atomic reversal
  update. This matches the folded, turn-scoped diff contract rather than
  advertising per-write identity the journal does not retain.
  Apply materializes only handles whose final branch state is active; handles
  eliminated by Work-draft write reversal are squashed rather than recreated as active live
  mutations for content that is absent. Each surviving branch journal row keeps
  its own live update identity and attribution. Writer rows therefore remain
  visible to the dependency predicate instead of being folded into an AI
  mutation or representative push author.
- **Intrinsic undo guard**: `persistUndo` in `adapters/drizzle-journal.ts` runs
  the dependency check (`hasDependentLaterRows` in
  `domain/journal-dependencies.ts`) inside the same transaction, under
  `lockDocumentMutation` advisory lock; nothing else guards a live
  reversal commit. Work-draft reversal uses the generation and
  journal-watermark fence above.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
