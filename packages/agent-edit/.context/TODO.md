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

A write that adds, removes or retypes a node inside a table or other container (a
table row), or breaks a line of
verse in two, is rewritten as a whole block, as if the writer had deleted nothing since
the model's read. A model insert beside a line the writer deleted can land split, a
rewrite can bring the deleted line back, and a change to a word the writer retyped can
land inside it. A block that keeps its shape is lowered to operations; what is left is
node insert and delete operations under a container, and an atom inserted in the middle
of a run (a work item of its own, after
[#1363](https://github.com/haowjy/meridian-flow/issues/1363)).

## Blocks a write removes and adds

A write that removes a block and adds another (merging or splitting top-level
paragraphs) is rewritten whole:
the writer's typing in the removed block goes, and text deleted from it can come back
in the added one. Covering it means deciding the replaced scope as one sequence, block
edges included, in `replaceScope`'s alignment.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
