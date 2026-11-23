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

Defaults are 20 seeds of 400 steps (about 90 seconds). It prints `ok: …` or each failed case or
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
docs and kept on B's screen. Undo: a Redo of a delete after the peer typed in the block stays (it
would hide the peer's words), a plain Redo of a delete lands and its Undo brings the block back,
two levels of Undo and Redo around deletes give back each document, B's Ctrl+Z in a block a
removal read followed by a batch removing something else leaves the block removed, and an agent's
text op or delete op (`applyOps` on a server copy) inside a container B's typing brought back keeps
it, through B's Ctrl+Z.

Then the step rule (design §2, "An Undo takes an edit back whole, or leaves it whole"): a step
someone else wrote over stays and writes nothing. A's own Enter goes back and comes back exactly.
A peer's later move, retype (`code_block` to `jsx_leaf`) or delete of a block survives A's Ctrl+Z
and Redo; seeds 289 and 55's shape (A and B move one block at once, B's move wins, B's Ctrl+Z puts
the key back) makes A's Ctrl+Z skip its move for the typing before it, which Redo gives back, as
it does for typing either side of a move a peer wrote over. After A's Enter, a peer that moves,
deletes, retypes, wraps, types in or bolds the new half, joins the halves back or deletes the
first half keeps the Enter (the reviews' torn blocks, text twice and words off the screen); a peer
typing in the first half does not, and a peer typing in the new half while A undoes gets the half
back with its words. A join whose target a peer retyped goes back; a wrap a peer moved a block out
of stays; a move whose Undo would put a block under a container a peer removed stays. From review
p18993: a peer's deletion still in flight when A's Enter stays lands everywhere (C2); a step that
stays takes only the steps of its own paragraphs out of the history, so Redo still gives back the
steps either side of it in other blocks (C3); with nobody else writing, Ctrl+Z takes back a
picture whose upload landed as an untracked write (C4). A split a peer wrote over takes the typing
under it out of the history; a peer's deletion of part of A's typing stays through A's Ctrl+Z.
From investigation p18995, one case per cause the seeds found: a peer's join takes away text A
deleted across two blocks unseen, and A's Ctrl+Z stays rather than show it twice (seed 414); a
draft that also deleted A's "F" is pressed into Live and the press undone, and A's Ctrl+Z goes
back, the undone delete counting as never made (review p19017); B's Ctrl+Z of its own delete of
that "F", before it sees A's, puts it back, and A's Ctrl+Z stays rather than show it twice; two
equal removals of one block, and the Ctrl+Z of the one that lost finds the other's value and stays
(477, with fixed peer ids); a move beside a block the caret keeps leaves that block removed (602);
the placeholder id `c/empty` (design §1): typing into it stores a fresh id, so an unwrap of the
container and a peer's concurrent move of it read no id twice and store no placeholder id; three
copies unwrapping, wrapping and moving the container at once show the typed text once, through
each copy's Ctrl+Z (review p18998); a peer filling a container whose paragraph B emptied, B's
caret in it, never shows B's deleted words again (seed 953); typing into the placeholder after a
peer emptied the container is a new paragraph without the removed one's words, and one Ctrl+Z
brings the placeholder back. From review p18996: one edit judged on its author's copy and on
a fresh copy gives one answer. A draft's Redo of a move whose override its Undo deleted stays once
Live has moved the block since. From review p18998: B's batch between each of A's 1,001 keys splits A's
one typing step into an item per key, and its Undo takes back every key.

What it checks: after every local edit, Undo, Redo and imported batch, each editor's document
equals a full read of its docs plus the blocks it keeps (`readProseMirror` without `since`), and
after a final exchange both copies read alike and no removal stands that did not read an editor's
typing in the block (each editor's counter after its last forward write into a text doc, against
the record's `seen`). Batches go whole or one doc at a time (the structure before its text or
after), and a random click moves the caret off a kept block. That is the binding's invariant, so it catches a write that skipped a
block it should have written (`writeDocument`'s `previous`) and a read that kept a node it should
have re-read (`readDocument`'s `since`). For Undo it checks more:

- an Undo keeps every word the other editor typed (each editor types words of its own, `qA3`,
  and they are looked for in the text of every doc, shown or hidden). Typing, Enter and paste go
  between words, never inside one (a word typed inside another reads as deleting it, seed 457): a split word could be joined back from copies by the other
  editor's Join, and that editor's Undo of the Join would look like it took the word (seed 85
  failed this way with peer salt 19; a raced case now runs it);
- after every Undo and Redo: no block is left with an `order` key and no `node` or `parent` (half a
  block); no word shows twice that showed once (a run that wrote no text is exempt: the Undo of a
  delete brings blocks back as they were); no word the other editor typed leaves the screen; no
  word a peer's edit took off this editor's screen comes back; and no mark a peer set or cleared
  on a word is undone (judged per place, by block and occurrence: a split and its Undo can
  leaves a copy of its words in two blocks, and a peer unbolding one copy says nothing about this
  editor's Undo rebolding the other, seed 1098 at `200 400 900`). A change
  a batch made is the peer's when the peer's screen shows it too, else it came of two edits meeting (a block moved into a container the other removed), which an
  Undo may bring back; a kept block leaving on a click counts the same way (seed 415). A Redo
  may take off the screen only words typed since the editor's Redo was last emptied, by any edit,
  in a burst too (seeds 460 and 483). The editor's screen counts, kept blocks included;
- a burst of edits with no batch between (and the chain below), started with the caret off any
  kept block, so the editor shows the docs' read, undone until the document is the one from
  before the burst gives it back exactly, and as many Redos give back the one after it; between
  the edits a write no Ctrl+Z takes back (a comment body under `UNTRACKED_ORIGIN`) lands and must
  stay out of every step;
- from an empty Redo, up to six Ctrl+Z then Redo until none is left give back the document,
  unless a step stayed on the way (it and the steps sharing its paragraphs leave the history,
  and what they did is still in the document).

The histories' clock stands still, so typing joins a step until the probe ends it on any machine
(the clock once made seeds flake under load); any other write starts a step, and one that sets
structure ends it, except typing into an empty paragraph, which stores it and joins as typing. `WHY=1` prints how many steps each run left, `TRACE=1` both screens after
every step.

The edits: typing, Enter (`split`), joining two blocks, pasting three paragraphs mid-block, bold
and italic on and off, a heading level, a delete across two blocks, moving a block (the same node
object at another place), wrapping two paragraphs in a `jsx_container` and unwrapping it,
inserting a table, emptying a cell to its `<cell>/empty` paragraph, removing a block, a comment
mark, and a comment's body set or deleted outside the editor (`setCommentBody` under
`UNTRACKED_ORIGIN`, then `notifyChanged`).

The burst check fails on Undo by character id at the change's own frontier (the rule before
1f): 9 of 10 seeds at 400 steps. PR #1848's first history (a structure key goes back while it
holds what the step left, each doc and key alone) fails 11 of the step rule's cases and 66 of 100
seeds at 400 steps under the Undo checks
([q14](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/loro-build/probe/scripts/q14-step-rule/README.md)). Not covered: drafts beyond the one Redo case (off until phase 2), a real IME composition (the
browser matrix; the raced cases dispatch the commit's transaction), the selection Undo puts back (the app sets it; checked by hand in the browser).
The block-id fixer here gives a fresh id to any missing or taken one; the app's keeps the id on
the half that was there. The editors' binding stores an empty container's placeholder under the
seed's own ids, so a seed replays exactly.
