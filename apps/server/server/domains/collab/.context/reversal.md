# Collab — reversal

## Undo guard and push safety

`reverseThreadContext` is the card's whole-turn command. The authenticated
POST accepts only `{scope: "turn", target: turnId, direction}` and rejects URI,
write-scope and thread-scope fields. Authorization precedes immutable inverse
planning; its per-document skips and accepted parts survive partial permission
refusals. The GET availability route serves Work receipts by turn target only.

- **Receipt actions and rollback use forward inverses**: `turn-inverse-service.ts`
  chooses one view per document and calls the same primitive for the command and
  its dry run. Redo comes first while the latest unconsumed Undo has a reapplicable
  accepted part; else an invertible active part offers Undo. Actions group edits
  across documents. Each inverse edit transitions one target edit, and appends
  ordinary immutable journal parts with restoration aliases, never rewriting a
  target row or marking it reversed. Partial results name skipped parts with their
  own before/after text. Card inverse rows are writer rows with no turn.
- **No reversal routing.** #757's reversal plan, origin registry and per-peer
  reversal endpoints are gone; the card and the model both use the one inverse
  engine above. A card Undo skips a part by name when its draft was discarded
  (`expired`, reason `discarded`) or an earlier writer edit depends on it
  (`cant_undo_dependent`), and inverts the rest. Those are named skips of parts
  that are targets. A turn's edit targets (`readTurnEditTargets`,
  `adapters/drizzle-turn-edit-targets.ts`) exclude tombstoned documents through
  the tree's `documentNotDeletedSql` (`context/tree/tree-view-sql.ts`), so a
  discarded draft-created document, or one the writer deleted, is never an
  inverse target and drops out of Undo as it already does from lineage. Final
  address liveness stays with the lineage reader;
  [#844](https://github.com/haowjy/meridian-flow/issues/844) plans to split the
  target list by reader. A model `write undo` of a draft edit after the chat's
  Work moved refuses `cant_undo_elsewhere`.
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
- **Model policy**: `model-inverse-policy.ts` owns one strict stack per
  thread/document. `write undo/redo` take a count; `revert` targets one immutable
  edit at the current destination. `read(format: "edits")` pages that history.
  No path uses a reconstruction planner, reversal table or reserved client 999.
- **Attribution**: restoration correspondence comes from certified aliases on
  immutable parts, not equal text or equal-length guesses. Apply moves placement
  to ordinary live journal rows; it does not fold or transfer reversal handles.
- **Notices**: card actions identify their turn and document, not model handles.
  Runtime context retains the latest action per turn/document and reports undos.
