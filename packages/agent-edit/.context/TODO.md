# agent-edit TODO

## One save sequencing

A write saves through `prepareSave` in `tool/document-save.ts`, but model inverses
commit outside the port: Undo, redo and revert journal and deliver through collab's
`drizzle-turn-inverse.ts`. So every save-time concern lands once per path.

Route inverses through `prepareSave`.

## Stale-view writes into structural blocks

A write that adds, removes or retypes a node inside a quote, list, table or other
container (a new list item, a table row), or breaks a line of
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
