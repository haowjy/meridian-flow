# Collab — reversal contracts

Two inverse paths use the forward-inverse primitive in `@meridian/agent-edit`
over immutable edit parts: the model's `write revert` and failed-response
rollback. An inverse is an ordinary immutable journal edit; it never rewrites a
target row or marks it reversed. The writer's undo is not an inverse edit: a
Discard is a local edit of the draft text, owned by the client (see
[draft review](../../../../../../apps/app/src/features/draft-review/AGENTS.md)).
There is no card Undo/Redo, no model `write undo`/`write redo`, and no reversal
routing, table or reserved client.

## Commands and policy

`write revert {path, edit}` targets one immutable edit by handle;
`read(format: "edits")` pages the thread's own edits. It writes into the thread's
current destination: the active draft's text branch (ensured and freshly seeded
if absent) or live. It writes ordinary journal rows with pending parts, so in a
draft it shows as a change the writer applies. It reverts the parts and blocks the
writer left alone and reports the rest ("revert 1 of 2"); with nothing left it
refuses `nothing_to_revert`, and an archived draft refuses `work_archived`.

Rollback (a failed reply) selects by edit scope (`ModelResponseIdentity`) and
records accepted parts as terminal `rollback` edits; parts already `discarded` or
rolled back are skipped, and only an uninvertible pending target keeps
`rollback_pending`. A repeated rollback appends nothing. A failed checkpoint or
report cannot reject a durable save.

Stored `undo` and `redo` edit kinds stay readable for old rows; nothing writes
them, and model edit entries and response-scoped discovery exclude them. A turn's
edit targets exclude tombstoned documents (`documentNotDeletedSql`), so a
discarded draft-created document is never an inverse target.

Placements are `pending`, `live` or `discarded`. Content Apply moves no part: edit
status is derived from the draft's text (`draft-edit-status.ts`: applied when the
part's text lies in no review change, pending inside one). Item Discard and
Discard all make the closed branch's pending parts `discarded`.

## Holds, effects, and failures

A pending inverse holds the roots whose draft identity differs from live. Holds
and destinations are branch-scoped and prepared from one locked invocation view;
a skipped hold marks its draft `blocking` so the item stays listed when its text
equals its base.

A draft inverse writes through `writeBranchState` with the text effect, inside
the Work projection mutation, so the Work page sees an effect change in the same
transaction. Publication is deferred until after commit (a live inverse recovers
the live room, refreshes the projection and flushes the rebase; a draft inverse
broadcasts to the branch room). Inverses take sorted transition locks,
branch/live process locks, Work rows, then ordinary admission locks; Apply does
not take the transition lock. Root pulls must not be awaited while holding Work
locks. Restoration correspondence comes from certified aliases on immutable
parts, never equal text.
