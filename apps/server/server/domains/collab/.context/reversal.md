# Collab — reversal

Two inverse paths remain, both over immutable edit parts and the forward inverse
primitive in `@meridian/agent-edit` (`undo/forward-inverse.ts`): the model's
`write revert` and failed-response rollback. The writer's undo is not an inverse
edit: a Discard is a local edit of the draft text, undone by Ctrl+Z in the editor
or the row's Undo (the browser's job, see
[branch-model-and-records.md](branch-model-and-records.md)). There is no card
Undo/Redo, no model `write undo`/`write redo`, and no reversal routing, reversal
table or reserved client 999.

- **`revert`** targets one immutable edit by handle (`write revert {path, edit}`),
  and `read(format: "edits")` pages the thread's own edits (`model-inverse-policy.ts`).
  It writes into the thread's **current destination**: in draft mode the active
  draft's text branch on the document, ensured and freshly seeded if absent; in live
  mode live. It writes ordinary journal rows with pending parts, so in a draft it
  shows as a change the writer applies. Content Apply moves no parts, so the AI's
  items are still there for `revert` to find. It reverts the parts and blocks of the
  edit the writer left alone and reports the rest ("revert 1 of 2": already removed,
  rolled back, edited since, held by another draft, its paragraph was removed); when
  nothing is left it refuses `nothing_to_revert`. A draft that is archived refuses
  `work_archived`.
- **Rollback** (a failed reply) selects by edit scope (`ModelResponseIdentity`) and
  transitions the response's accepted parts as terminal `rollback` edits; parts already
  `discarded` or rolled back are skipped, and only an uninvertible pending target row
  keeps `rollback_pending`. A repeated rollback creates no further inverse. Response
  checkpoints and refreshes enlist as post-commit participants, so a failed checkpoint
  cannot reject a durable save and reopen its response for rollback.
- **Edit kinds.** New inverse edits take their real kind, `revert` or `rollback`.
  Stored `undo` and `redo` kinds and the `reapply` target direction stay for old rows
  (the read type is a stored-value union). `model-inverse-policy.ts` keeps excluding
  historical `undo`/`redo` rows from model edit entries, and
  `drizzle-turn-edit-targets.ts` keeps them out of response-scoped discovery, so no
  deployment creates a new `wN` handle from them. Lineage follows effects and aliases,
  so `revert` of an old write still restores it.
- **Tombstones.** `readTurnEditTargets` excludes tombstoned documents through the tree's
  `documentNotDeletedSql` (`context/tree/tree-view-sql.ts`), so a Discarded
  draft-created document, or one the writer deleted, is never a rollback or revert
  target: its storage is released and there is nothing to lock. Final address
  liveness stays with the lineage reader.
- **Placements** are `pending` (`branchId`, `rowId`), `live` (`seq`) or `discarded`.
  Edit status is derived from the draft's text (`draft-edit-status.ts`): applied when
  the part's text lies in no review change, pending when it lies inside one, discarded
  when its text is gone from the draft. Item Discard and Discard all make the closed
  branch's pending parts `discarded`.
- **Holds.** A pending inverse holds roots where its draft's visible identity differs
  from live's (`inverse-holds.ts`); holds and destinations are keyed by branch ID.
  Only holds intersecting the selected targets can choose their holding draft. The
  locked invocation prepares one lineage/root-family index per document view. A skipped
  hold marks that draft `blocking` so the item stays listed when its text equals its
  base.
- **Locking.** An inverse takes sorted transition advisory locks
  (`document-inverse:<id>`), the branch leases, the live process locks, Work rows, then
  ordinary admission locks. Apply never takes the transition lock.
- **Effect.** A draft inverse writes through `writeBranchState` with the text effect
  (`draftDiffersFromBase` of the document written), inside the Work projection
  mutation, so the Work page and the catalog see an effect change in the same
  transaction as the write. Inverses defer their publication until after commit:
  a live inverse recovers the canonical live room, refreshes the projection and
  flushes the live-to-draft rebase; a draft inverse broadcasts its update to the
  branch room. Root pulls escape the caller's transaction, so callers must not await
  one while holding Work locks.
- **Attribution.** Restoration correspondence comes from certified aliases on
  immutable parts (`appendInverseRestorationFacts`), not equal text or equal-length
  guesses. Apply moves no parts and transfers no reversal handles.
