# Collab — reversal contracts

Reversal uses the same forward-inverse primitive for card actions, model
Undo/Redo/Revert, and failed-response rollback. An inverse is an ordinary
immutable journal edit; it never rewrites a target row or marks it reversed.

## Commands and policy

`reverseThreadContext` is the whole-turn card command. Its authenticated POST
accepts only `{ scope: "turn", target: turnId, direction }`; authorization
precedes inverse planning. One action may cover several documents, but each
inverse edit transitions one target edit and carries restoration aliases.
Dry-run and execution choose one destination view per document.

Redo is preferred when the latest unconsumed Undo has a reapplicable part;
otherwise an invertible active part offers Undo. Effective action state is
indexed per immutable part. A partial writer Undo does not expose an older
entry or mark the whole action undone. A rolled-back action has no stack
impact, and repeated rollback does not append another inverse.

The model owns one strict stack per thread/document. `write undo` and `write
redo` accept a count; `write revert` creates a new edit at the current
(destination) view; `read(format: "edits")` reads immutable parts through the
host port. Model actions cannot use a reconstruction endpoint, reversal table,
or reserved client. A multi-edit Undo is all-or-nothing and Redo restores the
last undone edit first; a count beyond what is available refuses with the
available count and changes nothing. User-actuated entries refuse model stack
commands, and a model Undo of a draft edit after the chat's Work moved refuses
`cant_undo_elsewhere`. A card Undo names and skips a part whose draft was
discarded (`expired`) or that a later writer edit depends on
(`cant_undo_dependent`), and inverts the rest.
A turn's edit targets exclude tombstoned documents (`documentNotDeletedSql`), so
a discarded draft-created document or one the writer deleted is never an
inverse target and drops out of Undo as it does from lineage. Final address
liveness stays with the lineage reader.

Card authorization and change-viewer discovery share immutable edit and
placement targets with inverse admission; mutation and branch transport
journals are never authorization lineage. Card inverse rows are writer rows
with no turn, and restoration correspondence comes from certified aliases on
immutable parts, never equal text. Save and rollback take a
`ModelResponseIdentity`, not a bare string that could mean provider response or
helper scope: `response_id` keeps provider authorship and `edit_scope_id`
selects the rotated scope.

Apply moves a part's placement to its authored live row, never the reconcile
row; Discard and empty-draft reset make discarded and retired placements
terminal. Runtime context reports a card action by turn and document, not by
model handle.

## Holds, effects, and failures

A pending inverse holds the roots whose draft identity differs from live. Holds
and destinations are branch-scoped and prepared from one locked invocation
view. Only intersecting holds can select a holding draft. A skipped hold keeps
the draft blocking so Apply/Discard remains reachable even when visible prose
equals live.

`hasEffect` compares prose and managed manifest membership with the draft's
last pulled live cut; pending lists, counts, and Work notifications read that
effect or `blocking`, never raw journal-row count. Pull snapshot, effect, and projection updates commit in
their own root transaction. Inverses take sorted transition locks, branch/live
process locks, Work rows, and ordinary admission locks; Apply does not take
the transition lock. Root pulls must not be awaited while holding Work locks.

A card outcome reports committed destination per document. Draft Undo says that
Apply is needed to change the manuscript. The reverse endpoint may return
semantic unavailable outcomes such as `nothing_to_undo`, `nothing_to_redo`,
`cant_undo_dependent`, `expired`, or `partial` with HTTP 200; callers retain
those outcomes and refresh the turn query.

Failed-response rollback selects immutable parts by `editScopeId`, records
accepted parts as terminal rollback edits, and keeps only uninvertible pending
targets in `rollback_pending`. A failed checkpoint or report cannot reject a
durable save.
