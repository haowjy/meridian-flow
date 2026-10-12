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

- **Receipt actions and rollback use forward inverses**: `turn-inverse-service.ts`
  chooses one view per document and calls the same primitive for the command and
  its dry run. Redo comes first while the latest unconsumed Undo has a reapplicable
  accepted part; else an invertible active part offers Undo. Actions group edits
  across documents. Each inverse edit transitions one target edit, and appends
  ordinary immutable journal parts with restoration aliases, never rewriting a
  target row or marking it reversed. Partial results name skipped parts with their
  own before/after text. Card inverse rows are writer rows with no turn.
- **Effective actions**: `inverse-actions.ts` indexes accepted Undo targets per
  part and subtracts only effective Redo consumption. Rolled-back actions have
  no stack effect. Card placement/partial selection and model strict stack
  selection share that index, not their policies. A model entry is popped only
  when every part is undone or terminally rolled back; partial writer Undo never
  exposes an older entry or labels the entire entry undone by the user.
  Rollback is terminal only for its direct selected target, not that inverse's
  transitive originals. Failed inverse scopes restore previous availability.
- **Holds and locking**: a pending inverse holds roots where its draft's visible
  identity differs from live's. Holds and destinations are keyed by branch ID.
  Only holds intersecting the selected targets can choose their holding draft.
  The locked invocation prepares one lineage/root-family index per document view
  and shares its immutable hold evidence across Redo and Undo dry runs.
  A skipped hold marks that draft blocking so Apply/Discard stays reachable when
  its prose equals live. Inverses take sorted transition advisory locks, all branch
  and live process locks, Work rows, then ordinary admission locks. Apply never
  takes the transition lock. Preparation includes the locked live cut in a draft.
- **Effect and rollback**: `hasEffect` compares visible prose and managed manifest
  membership to the draft's last pulled `liveCut`. Lists, counts and Work
  publication use effect or blocking, and both counts share one predicate
  (`shared/work-draft-pending-count.ts`). Pull snapshot/effect updates enlist the
  same Work projection participant as writes, so an effect change takes a Work
  SQL row lock even without a lifecycle helper. Each branch pull therefore commits
  snapshot, effect and projection in its own root transaction before acquiring
  the next branch mutex; receipts and inverses take branch mutexes before Work
  rows. Root pulls escape the caller's transaction, so callers must not await one
  while holding Work locks (inverses defer it until after commit). Committed live
  inverses recover the canonical live room before pulling drafts, even when there is no active draft. Card outcomes
  carry committed per-document destinations; a draft Undo explicitly says Apply
  is needed to change the manuscript. Only Apply/Discard retire an
  empty generation. Failed-response rollback selects by edit scope and transitions
  accepted parts as terminal rollback edits; only uninvertible pending target rows
  retain rollback_pending. Repeated rollback does not create another inverse.
  Response checkpoints and refreshes enlist as post-commit participants; a failed
  checkpoint cannot reject a durable save and reopen its response for rollback.

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
- **Model-engine aggregate reversal is durable-atomic and runtime-staged**: production persists
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
  the dependency check (`@meridian/agent-edit`'s `hasDependentLaterRows`, the
  same rule the model command’s `planUndo` uses) inside the same transaction, under
  `lockDocumentMutation` advisory lock; nothing else guards a live
  reversal commit. Work-draft reversal uses the generation and
  journal-watermark fence above.
- **Tombstone cap**: `gc: false` on all branch `Y.Doc` instances — full struct
history is preserved for attribution, echo, and undo dependency checking.
