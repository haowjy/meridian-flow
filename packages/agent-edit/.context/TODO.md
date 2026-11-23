# agent-edit TODO

## Blocks a write removes and adds

A write that removes a block and adds another (merging or splitting top-level
paragraphs) is rewritten whole:
the writer's typing in the removed block goes, and text deleted from it can come back
in the added one. Covering it means deciding the replaced scope as one sequence, block
edges included, in `replaceScope`'s alignment.

## The model's Undo echo

The model's `undo` and `revert` answer with the inverse's message only (`undone: e3`), not the
changed blocks and their neighbours bounded like a write's receipt. The model re-reads to see the
text. The inverse's part records its `delta` (collab's
`drizzle-turn-inverse.ts`), which is what an echo would render.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
