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

## Stale-view writes into structural blocks

A write that adds, removes or retypes a node inside a quote, list, table or other
container (a new list item, a table row, a paragraph made a heading), or breaks a line of
verse in two, is rewritten as a whole block, as if the writer had deleted nothing since
the model's read. A model insert beside a line the writer deleted can land split, a
rewrite can bring the deleted line back, and a change to a word the writer retyped can
land inside it. A block that keeps its shape is lowered to operations; what is left is
node insert and delete operations under a container, and an atom inserted in the middle
of a run (a work item of its own, after
[#1363](https://github.com/haowjy/meridian-flow/issues/1363)).

## Deletes that land after a write read its room

A block rewrite that `lowerBlock` keeps is decided against what its room copy has deleted, but only what the copy holds when the call reads it. A
delete that lands later still meets a lowering that kept those units. For a draft
write the window runs from the call's room read to the step's save: the rest of the
model step, its generation and later tool calls included, seconds to minutes. For a
direct save it is the time to the save. Find writes are
placed by their windows and survive it; other rewrites can split. The rule is a pure
function of the two blocks and the deleted units, so the fix is to run it again at
save time against the room the update merges into.

## Blocks a write removes and adds

A write that removes a block and adds another (merging or splitting top-level
paragraphs, a paragraph turned into a heading) is not decided against room deletions:
the writer's typing in the removed block goes, and text deleted from it can come back
in the added one. Covering it means deciding the replaced scope as one sequence, block
edges included, in `replaceScope`'s alignment.

## Changes the room added

The rule sees what the writer deleted, never what they added. A pasted sentence can
keep letters of the old one, which a model delete then takes (`MinKeep end.`), and a
landing change cannot tell a plain delete from typed-over text, which is why a change
that covers any deleted unit is skipped. Both need the port to also report where the
room holds text the view lacks.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
