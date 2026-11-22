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

## A whole-block rewrite after the writer's turn Undo

The writer's turn Undo is a writer edit after the chat's read, so the chat's view keeps the chat's
own words. A `find` now falls back to the room (CONTEXT.md, the edit core), but a replace by hash
whose content equals the view still answers `unchanged: ... the document as you last read it
already holds this content` while the room holds the restored text: the same rewrite asked for
again after an Undo does nothing. (Under Yjs the view withdrew rejected suggestions for this.) A Loro
version can't take in the Undo's ops without the writer edits before it, so the fix is a choice
between advancing the chat's view at its turn Undo, which loses the read-time protection for writer
edits made between the read and the Undo, and planning such a write on the room.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
