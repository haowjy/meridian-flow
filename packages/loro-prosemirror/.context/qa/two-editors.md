# Two editors, random structural edits

`two-editors.probe.ts` puts two editors with the binding on two copies of one room, makes random
edits on either side and exchanges batches at random. Run it when the binding's write or read
path, `writeDocument`, `readDocument` or the codec's node ↔ block mapping changes:

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps]
```

Defaults are 20 seeds of 400 steps (about a minute). It prints `ok: …` or each failed seed with
the block the editor shows beside the one the docs read, and exits non-zero.

What it checks: after every local edit and every imported batch, each editor's document equals a
full read of its docs (`readProseMirror` without `since`), and after a final exchange both copies
read alike. That is the binding's invariant, so it catches a write that skipped a block it should
have written (`writeDocument`'s `previous`) and a read that kept a node it should have re-read
(`readDocument`'s `since`).

The edits: typing, Enter (`split`), joining two blocks, pasting three paragraphs mid-block, bold
and italic on and off, a heading level, a delete across two blocks, moving a block (the same node
object at another place), wrapping two paragraphs in a `jsx_container` and unwrapping it,
inserting a table, emptying a cell to its `<cell>/empty` paragraph, removing a block, a comment
mark, and a comment's body set or deleted outside the editor (`setCommentBody`, then
`notifyChanged`).

Not covered: drafts (off until phase 2), IME composition (the browser matrix), and Undo
(`editor-history.ts` in the app). The block-id fixer here gives a fresh id to any taken one; the
app's keeps the id on the half that was there.
