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
docs and kept on B's screen. Undo: a Redo of a delete lands with a record of what it reads now, so a peer's later typing
brings the block back; its Undo brings the block back; two levels of Undo and Redo around deletes
give back each document; B's Ctrl+Z in a block a removal read, followed by a batch removing
something else, leaves the block removed; and an agent's text op or delete op (`applyOps` on a
server copy) inside a container B's typing brought back keeps it, through B's Ctrl+Z.

Then the step rule (design §2, "An Undo always runs"): every Ctrl+Z and Redo runs. A text inverse
deletes the step's own characters and puts back what it deleted; a structure key goes back by last
writer wins, over a peer's later write. A's own Enter goes back and comes back exactly. A peer's
later move, retype (`code_block` to `jsx_leaf`) or delete of a block is written over by A's Ctrl+Z
and again by its Redo; in seeds 289 and 55's shape (A and B move one block at once, B's move wins,
B's Ctrl+Z puts the key back), A's Ctrl+Z takes back its typing before the move, and Redo gives it
back. After A's Enter, A's Ctrl+Z runs over a peer that moves, wraps, types in or bolds the new
half, deletes the first half or joins the halves back: the tail goes back into the first half, a
half a peer typed in comes back with those words alone (rule 1 over the Undo's own write), a
peer's join leaves the tail beside its copy (text twice), and a bold is lost (a hole). A join a
peer retyped goes back, as does a wrap a peer moved a block out of; a move whose Undo puts a block
under a container a peer removed brings the container back with it. From review p18993: a peer's
deletion still in flight when A's Ctrl+Z puts the tail back finds nothing (a hole) and the words
stay (C2); the steps either side of a split a peer typed in go back and come again (C3); with
nobody else writing, Ctrl+Z takes back a picture whose upload landed as an untracked write (C4).
From investigation p18995, one case per cause the seeds found: a peer's join takes away text A
deleted across two blocks unseen, the import restores the block beside the join's copy, and A's
Ctrl+Z goes back with no word lost (seed 414); a draft that also deleted A's "F" is pressed into
Live and the press undone, and A's Ctrl+Z goes back, the undone delete counting as never made
(review p19017); B's Ctrl+Z of its own delete of that "F", before it sees A's, puts it back, and A's
Ctrl+Z puts it back too (text twice); a peer's Backspace run (one delete op with a negative `len`)
over text A deleted, and A's Ctrl+Z puts it back; two equal removals of one block, and the Ctrl+Z
of the one that lost puts the block back over the other's (477, with fixed peer ids); a move beside
a block the caret keeps leaves that block removed (602); the placeholder id `c/empty` (design §1):
typing into it stores a fresh id, so an unwrap of the container and a peer's concurrent move of it
read no id twice and store no placeholder id; three copies unwrapping, wrapping and moving the
container at once show the typed text once, through each copy's Ctrl+Z (review p18998); a peer
filling a container whose paragraph B emptied, B's caret in it, never shows B's deleted words
again (seed 953); typing into the placeholder after a peer emptied the container is a new
paragraph without the removed one's words, and one Ctrl+Z brings the placeholder back. A join that
did not read a peer's typing gives the block back beside its copy, whether the typing arrives
after the join (rule 1) or the typer's caret kept the block (the caret rule), and so does a join
followed by a split of its copy, or two joins in a row (reviews p19056, p19057). From review
p18996: one edit judged on its author's copy and on a fresh copy gives one answer. From review
p18998: B's batch between each of A's 1,001 keys splits A's one typing step into an item per key,
and its Undo takes back every key.

Drafts: a draft's Undo deletes its override, Live then moves the block, and the draft's Redo
writes its override over that move. A Draft tab's Ctrl+Z of an edit the writer then applied: the
press deleted the overrides it read, so Ctrl+Z of a split, a move or a retype finds nothing to put
back and the draft shows the applied edit, while Ctrl+Z of typing takes the text back as a pending
change against Live. With the Apply undone first, Ctrl+Z and `Restore before` of the move and the
retype take them back; the press's Undo returned the split's and the typing's text to the draft as
new characters, which neither deletes (they take back the edit's own characters), so that text
stays and no word is lost (review p19057).

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
  block), and no word the other editor typed leaves the screen. A Redo may take off the screen
  only words typed since the editor's Redo was last emptied, by any edit, in a burst too (seeds
  460 and 483). The editor's screen counts, kept blocks included. What last writer wins allows is
  counted, not failed, and printed in the final line: a word showing twice that showed once
  (`shownTwice`; a run that wrote no text is exempt, since the Undo of a delete brings blocks back
  as they were), a word a peer's edit took off the screen coming back, and a mark a peer set or
  cleared undone (`overPeers`; marks judged per place, by block and occurrence, seed 1098 at
  `200 400 900`). A change a batch made is the peer's when the peer's screen shows it too, else it
  came of two edits meeting (a block moved into a container the other removed); a kept block
  leaving on a click counts the same way (seed 415);
- a burst of edits with no batch between (and the chain below), started with the caret off any
  kept block, so the editor shows the docs' read, undone until the document is the one from
  before the burst gives it back exactly, and as many Redos give back the one after it; between
  the edits a write no Ctrl+Z takes back (a comment body under `UNTRACKED_ORIGIN`) lands and must
  stay out of every step;
- from an empty Redo, up to six Ctrl+Z then Redo until none is left give back the document. When
  a peer wrote over one of the steps since, the steps go back over the peer's write and come again
  over it, so the document can differ: the chain then passes when no word either editor typed is
  lost and every block both reads show has the same text (`chainsOverPeers`).

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
1f): 9 of 10 seeds at 400 steps. Not covered: drafts beyond the Redo and Apply cases, a real IME composition (the
browser matrix; the raced cases dispatch the commit's transaction), the selection Undo puts back (the app sets it; checked by hand in the browser).
The block-id fixer here gives a fresh id to any missing or taken one; the app's keeps the id on
the half that was there. The editors' binding stores an empty container's placeholder under the
seed's own ids, so a seed replays exactly.
