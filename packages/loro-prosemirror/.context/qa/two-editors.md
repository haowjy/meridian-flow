# Two editors, random structural edits

`two-editors.probe.ts` puts two editors with the binding and its Undo on two copies of one room,
makes random edits, Ctrl+Z and Redo on either side and exchanges batches at random. Run it when
the binding's write or read path, `writeDocument`, `readDocument`, the codec's node ↔ block
mapping or `UndoHistory` changes:

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
```

Defaults are 20 seeds of 400 steps (about 30 seconds). It prints `ok: …` or each failed case or
seed with the block the editor shows beside the one the docs read, and exits non-zero.

Before the seeds it runs the raced removals: A removes a block while B types into it and the
batches cross (the phase 1 gate's lost `[remo`). B's typing must show on both screens, whether it
lands before the removal reaches B or straddles it; B's Ctrl+Z of that typing lets the removal
stand; a removal that read the typing stands, as does a second removal of a revived block; and
typing into a cell of a removed table brings the whole table back.

What it checks: after every local edit, Undo, Redo and imported batch, each editor's document
equals a full read of its docs (`readProseMirror` without `since`), and after a final exchange
both copies read alike. That is the binding's invariant, so it catches a write that skipped a
block it should have written (`writeDocument`'s `previous`) and a read that kept a node it should
have re-read (`readDocument`'s `since`). For Undo it checks three more things:

- an Undo keeps every word the other editor typed (each editor types words of its own, `qA3`,
  and they are looked for in every text doc, shown or hidden);
- a burst of edits with no batch between, most a step of their own and some joining the step
  before, undone step by step gives back the document from before the burst exactly, and redone
  gives back the one after it; between the edits a write no Ctrl+Z takes back (a comment body
  under `UNTRACKED_ORIGIN`) lands and must stay out of every step;
- from an empty Redo, up to six Ctrl+Z then Redo until none is left give back the document. A
  Redo can take two steps there: a step whose key a peer wrote since undoes to an op that
  changes nothing, so its Redo is nothing and the press goes on to the next.

The edits: typing, Enter (`split`), joining two blocks, pasting three paragraphs mid-block, bold
and italic on and off, a heading level, a delete across two blocks, moving a block (the same node
object at another place), wrapping two paragraphs in a `jsx_container` and unwrapping it,
inserting a table, emptying a cell to its `<cell>/empty` paragraph, removing a block, a comment
mark, and a comment's body set or deleted outside the editor (`setCommentBody` under
`UNTRACKED_ORIGIN`, then `notifyChanged`).

The burst check fails on Undo by character id at the change's own frontier (the rule before
1f): 9 of 10 seeds at 400 steps. Not covered: drafts (off until phase 2), IME composition (the
browser matrix), the selection Undo puts back (the app sets it; checked by hand in the browser).
The block-id fixer here gives a fresh id to any taken one; the app's keeps the id on the half that
was there.
