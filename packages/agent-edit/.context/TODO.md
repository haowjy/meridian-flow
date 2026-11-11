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

## Stale-view word diff

Some writes are lowered by word-diffing each old block against its new text, on the
model's view. Words the diff keeps are the old items; if someone deleted them since
the model's last read, the model's new text loses them and lands split and reordered.
That reaches:

- a scope `replace` (`in`, or a whole-document write);
- a find whose match windows can't be mapped onto the blocks: a match inside a link
  target, content that splits or joins blocks, content that would break the
  surrounding markup, private-use characters in the block;
- any find into a block that isn't a single run of text: a list, a blockquote, a
  paragraph with a hard break or an image.

Smallest case: the view holds `A disciple. DRAFT-B line. SIDETEXT`, the writer
deletes ` DRAFT-B line.`, and the model replaces the block with
`A disciple. DRAFT-B2. SIDETEXT`: the room gets `A disciple.B2 SIDETEXT`. The same
happens to `> A disciple. SIDETEXT` and `- A disciple. SIDETEXT` with a find insert,
in direct mode too. Removing it needs the write planned against the current room, so
no kept word is one the room has deleted.

## Deferred until earned

- Remove the remaining ProseMirror shape coupling from parsed-content types;
  the live-doc side already uses the neutral `AgentEditModel` seam.
- Freeze a public `DocumentPort`/`HistoryPort` after a second implementation
  reveals stable contracts.
