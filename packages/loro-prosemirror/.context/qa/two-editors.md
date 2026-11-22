# Two editors, random structural edits

`two-editors.probe.ts` puts two editors with the binding and its Undo on two copies of one room,
makes random edits, Ctrl+Z and Redo on either side and exchanges batches at random. Run it when
the binding's write or read path, `writeDocument`, `readDocument`, the codec's node ↔ block
mapping or `UndoHistory` changes:

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/two-editors.probe.ts [seeds] [steps] [first seed] [peer salt]
```

`HANDLES=1` fails the run if any Loro handle the probe made was never freed (`document-model`'s
`handles.ts`: each container, version vector and cursor is WASM memory no GC frees), naming the
code that made it. `MEM_EVERY=25` prints the WASM memory every 25 seeds; it only grows, so with
every handle freed it stops once the largest document fits.

A seed replays exactly: the edits, both copies' peer ids and the writer's order keys all come from it
(Loro orders concurrent ops by peer id, so a failure can depend on them). `first seed` runs seeds
from there up, so `… 1 400 85` reruns seed 85 alone; a different `peer salt` gives the same seed
other peer ids, to look for the ids a failure needs.

Defaults are 20 seeds of 400 steps (about 30 seconds). It prints `ok: …` or each failed case or
seed with the block the editor shows beside the one the docs read, and exits non-zero.

Before the seeds it runs the raced removals (design §1, "Removed blocks"): A removes a block while
B types into it and the batches cross (the phase 1 gate's lost `[remo`). B's typing must show on
both screens, whether it lands before the removal reaches B or straddles it; B's Ctrl+Z of that
typing keeps the block, without the typing (the restore is nobody's Undo step); a removal that read
the typing stands, as does a second removal of a restored block; typing into a cell of a removed
table brings the whole table back. Then the caret rule, where the removal reaches B between two
keys: B's screen keeps the block while the caret rests in it, and the next key, an IME commit, a
paste, a Backspace or an Enter brings it back (also when the removal read B's first keys, in a cell
of a removed table, and under two removals on the caret's path, a paragraph by A and its table by
a third editor); the caret leaving takes it off the screen; an untracked write elsewhere (an
attribute and a move of a sibling, as an upload or a chip respelled does) leaves it removed in the
docs and kept on B's screen. Undo: a Redo of a delete after the peer typed stands and an Undo after
it brings the block back, Redo items under a re-stamped removal survive, B's Ctrl+Z in a block a
removal read followed by a batch removing something else leaves the block removed, and an agent's
text op or delete op (`applyOps` on a server copy) inside a container B's typing brought back keeps
it, through B's Ctrl+Z.

What it checks: after every local edit, Undo, Redo and imported batch, each editor's document
equals a full read of its docs plus the blocks it keeps (`readProseMirror` without `since`), and
after a final exchange both copies read alike and no removal stands that did not read an editor's
typing in the block (each editor's counter after its last forward write into a text doc, against
the record's `seen`). Batches go whole or one doc at a time (the structure before its text or
after), and a random click moves the caret off a kept block. That is the binding's invariant, so it catches a write that skipped a
block it should have written (`writeDocument`'s `previous`) and a read that kept a node it should
have re-read (`readDocument`'s `since`). For Undo it checks three more things:

- an Undo keeps every word the other editor typed (each editor types words of its own, `qA3`,
  and they are looked for in the text of every doc, shown or hidden). Enter and paste cut a block
  between words, never inside one: a split word could be joined back from copies by the other
  editor's Join, and that editor's Undo of the Join would look like it took the word (seed 85
  failed this way with peer salt 19; a raced case now runs it);
- a burst of edits with no batch between (and the chain below), started with the caret off any
  kept block, so the editor shows the docs' read, most a step of their own and some joining the step
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
1f): 9 of 10 seeds at 400 steps. Not covered: drafts (off until phase 2), a real IME composition (the
browser matrix; the raced cases dispatch the commit's transaction), the selection Undo puts back (the app sets it; checked by hand in the browser).
The block-id fixer here gives a fresh id to any taken one; the app's keeps the id on the half that
was there.
