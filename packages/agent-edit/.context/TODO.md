# agent-edit TODO

## One save sequencing

A save still has two sequencings, and model inverses commit outside the port. The
reply save (and the pool's draft one-entry reply) prepares, persists inside the
pool's transaction and reports before commit (`response-committer.ts`); the
immediate save, `saveNow` in `tool/document-save.ts`, persists in a transaction
`appendBatch` owns and reports after durability. Undo, redo and revert journal and
deliver through collab's `drizzle-turn-inverse.ts`. So every save-time concern
lands once per path, and a drafted agent write outside a reply carries no
save-time "only if empty" precondition, which only `saveNow` passes.

Unify them: have `saveNow` run the reply path's prepare, persist and report inside
one transaction the host owns, and route inverses through `prepareSave`.

## Deletes that land after a write read its room

A block rewrite is lowered around what its room copy has deleted
(`withoutRemovedUnits`), but only what the copy holds when the call reads it. A
delete that lands later still meets a lowering that kept those units. For a draft
write the window runs from the call's room read to the step's save: the rest of the
model step, its generation and later tool calls included, seconds to minutes. For a
direct save it is the time to the save. Find writes into a paragraph or heading are
placed by their windows and survive it; other rewrites can split. Fix by lowering the
staged update again at save time against the room it merges into.

## Edits to text the editor retyped

Joining two lines or deleting an inline image makes the editor delete the following
text and insert it again as new items. A model change planned on the old items lands
on deleted text, so it is skipped and the result says so; before, it was lost without
a word. Landing it needs the retyped text matched to the old by content.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
