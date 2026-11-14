# agent-edit TODO

## One save sequencing

A write saves through `prepareSave` in `tool/document-save.ts`, but model inverses
commit outside the port: Undo, redo and revert journal and deliver through collab's
`drizzle-turn-inverse.ts`. So every save-time concern lands once per path.

Route inverses through `prepareSave`.

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
