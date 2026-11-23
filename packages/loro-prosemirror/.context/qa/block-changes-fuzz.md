# Block changes: the press, its Undo, Discard and Restore before

`block-changes-fuzz.probe.ts` runs seeded scripts against `@meridian/document-model`'s
block-change model (`changedBlocks`, `applyBlocks`, `discardBlocks`, `undoPress`, `takeBack`,
`undoEdits` for `Restore before`) and the Undo rule (`take-back.ts`) on the real schema, through the binding's codec, with no stack. Gate 5's fuzz
moved onto the product: removals are the product's records, restored by its own `importBatch`.
Run it when any of those functions, `write.ts`'s override rules, `remove`/`restore`, `importBatch`
`take-back.ts`, or the codec's block mapping change:

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/block-changes-fuzz.probe.ts --n 1000 [--start 0]
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/block-changes-fuzz.probe.ts --seed 37
```

A run prints each failing seed with its check and a `SUMMARY` line (counts of every step and check),
and exits non-zero on a failure. A seed takes about 0.1 s; split 10,000 across processes with
`--start`/`--n`. `--seed N` replays one script; with `FUZZ_TRACE=1` it prints, after each step,
every block where Live (L), the fork (F) and the Draft tab (T) differ, and the fork's overrides.
`FUZZ_OFF=split,join` leaves edit kinds out of the generator (`block-changes.gen.ts`).
`FUZZ_NO_PIECES=1` writes no `pieces` record, to see the split and join checks fail (188 of 300 seeds).

## The copies

Live and its Live tab (a writer typing in Live, synced at random, so a press can meet Live typing
the pressing tab never saw), the fork (the draft's room copy, with its own Live copy) and the Draft
tab (its own copies of both, synced at random; a stale Draft tab goes on typing after a Discard
all). Every Live write in a press goes through the product's own import and restore rule; the
probe never writes a removal or a restore itself. Each press, Discard and Undo runs on a command's own
copy of the fork room, as the server runs them, so its writes have fresh peers. Only the changes it
returns reach the rooms, encoded as the server commits them (`encodeChanges`), Live's first and the
fork forwarded before its own: a write the press made but didn't return never lands (an Apply of a
created block once left its text out of Live, which syncing the whole copy hid). Its changes are
stored as JSON and read back.

## Steps

- Writer edits in Draft (text, marks, comments, inline nodes, block inserts, deletes, moves,
  splits, joins, type changes, table rows), Ctrl+Z of the edit just made through `editStays` and
  `takeBack`, AI turns on a copy of
  the fork, and `Restore before` of a turn (`undoEdits` over the turn's edits, newest first).
- A press of random changes (`applyBlocks`), carrying as the Live version the writer was shown the
  Live tab's (half the time) or the Changes list's (the server copy's, just read), with Live typing
  the tab never saw and Draft typing landing after it.
- Its Undo (`undoPress`), with Draft typing and Live writes between.
- Dependent presses: 2 to 5 presses over one block, with Live and Draft typing between, undone
  newest first and in random order.
- Live and Draft deletions and replacements over a press's text before its Undo (the later write
  of design §2's edit rule), retypes that hold the press's text or are held by it ("house" pressed,
  then "household" or "hous"), typing right after it, which in a chain is often text a later
  press's Undo put back, and a rewrite that keeps one of the press's characters inside its own text,
  as a chat's rewrite keeps the letters it shares. These are written by position, as the editor's
  typing is (`replaceText`), so every character a retype types is new and can spell the press's text
  without being it.
- A draft that replaces one word or two in a block, pressed alone, then one of its replacements
  overwritten: the change stays whole, as a Ctrl+Z step does.
- A Work's `Apply all` over two drafts that both rewrite one paragraph, on a copy of the Live room:
  pressed in draft order, sometimes with Live typing between, and undone draft by draft, newest
  first.
- One-change Discard and its Undo, Discard all and its Undo, and a stale Draft tab across a Discard
  all.
- At the end of every script, after the seeded steps so earlier seeds read as before: one way of
  moving text between clean paragraphs, then an Apply or a Discard that names one of the blocks,
  and half the time its Undo (`halves`). The ways: Enter inside a paragraph (`split`), a join
  (`join`), a delete from inside one paragraph to inside the next (`crossDelete`), typing over
  such a selection (`typeOver`), an insert and then that delete in one transaction (`multi`), a
  paste of two paragraphs into the middle of one (`paste`), and a join followed by Enter at the
  same place, which leaves the first paragraph reading as Live's (`joinEnter`). Then rewrites of
  two neighbouring paragraphs where one loses three characters the other gains, and an Apply of
  the first (`neighbours`).

## Checks

- After a press: the chosen changes are no longer pending, unchosen blocks in Live are unchanged,
  pressing again commits nothing, Live typing the tab never saw is in Live and the fork, and Draft
  typing after the press is pending.
- After a press Undo: a change the Undo left (`stayedChanges`: someone wrote over it, design §2's
  four parts) changed nothing in Live or the fork, and with nothing written since the press
  (`quietUndos`) no change stays. Undone in turn with no change left, Live is back to before the
  press when nothing else wrote Live, and the fork reads as before. Out of order, the fork's text in
  every shown block is unchanged.
- **An Undo takes a change back whole, or leaves it whole** (`wholeChecks`): for each text doc of a
  change that did not stay, the Undo put back every character the press deleted, in order, and left
  none of the press's characters in Live. Ctrl+Z is held to the first half too.
- **No Undo puts back text a later write removed** (`replacedChecks`): where a later write removed any
  character a press put in a text doc, the change stays and that doc is unchanged: neither the old
  text back beside or inside the later write, nor the press's characters it kept taken out of it.
  The check once covered only a press's one replacement removed whole, and checked a change that went
  back against the press's own characters alone, so a rewrite keeping some of them, scrambled by the
  Undo, passed (#1854).
- Identity is by character id, from the probe's own record of what each Undo put back (the
  characters it inserted, lined up with the ones the edit deleted), never from the take-back messages
  the model reads, and never by what the text spells.
- **Blocks a write moved text between are one change, and independent rewrites are two** (design
  §2, "Which paragraphs go together"): the changed blocks of each way above are in one change, a
  press naming either acts on both, Live shows none of the moved words twice, and after the
  press's Undo they are one change again. Two rewritten neighbours are two changes, and applying the first leaves
  the second pending.
- After a writer edit: no override this write set equals Live's (including an order override that
  puts the block where Live's key would).
- After the two drafts' Undo: neither press stays, Live is back (or holds the typing between), each
  draft has only that paragraph pending, and no character of either draft's text is lost. When both
  drafts deleted one character, the second press's import deleted it again, and its Undo took that
  delete back, so the first press goes back too (part 4 of the rule).
- After `Restore before`: each of the turn's edits went back whole or stayed whole.
- At the end, after `Apply all`: Live, the fork and both tabs converge; nothing is pending; every
  comment mark has its body; no token is duplicated; block ids are unique; no block is pending that
  no write touched, except the accepted copies (below).

## Accepted, and counted rather than failed

Text or marks that a Discard, an Undo or a restore puts back are new operations by the fork, since
Loro has no undelete. A later Live delete or unmark inside that span leaves the fork's copy, which
then shows as a pending change the writer can Discard again (design §1, gate 5's N7). The summary
counts these as `resetCopyObserved`. Text both drafts deleted comes back into the second draft: the
first press's Undo puts it back into Live as new characters that draft never deleted
(`twoDraftsGained`, design §2, open). The check fails if a draft gains any other text.

**Accepted cost** (design §2, "the order of put-back text"): in the two-drafts case, text the first
draft deleted around the second's rewrite comes back with the first press's Undo as one run of new
characters, and Loro may place it on either side of the second draft's own re-created words
(`twoDraftsMoved`, about 6 runs in 1,000 seeds). No character is lost and every copy agrees, but the
draft's words read in another order; the check fails on a lost character only. Design §2's proposed fix (put the text back where the deleted characters were, by a
cursor on them) does not reach it: in the reordered runs the cursor resolves to the index the
transform already uses. The two runs are concurrent inserts at one gap (Live never sees the draft's
re-created words), and Loro orders those itself; an insert by index cannot choose a side.

Every word counts at the end: a word a split or a join moved is a duplicate like any other, and a
Live token counts as lost only when the fork shows it neither where Live typed it nor where Live
holds it now (a Live split carries it on). At 10,000 seeds (2026-11-23, gate press-whole) 9,993
pass. The rest are open classes, not grouping:
- `duplicate-text`, Live and the draft or a chat each split or joined the same text (class C of
  [gate/press-whole](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/loro-build/gate/press-whole/README.md),
  part 3's rules 1 and 3): 583, 1116, 1187, 1661, 3285, 3792.
- `stale-discarded-back` 6611: a stale Draft tab's insert anchored inside text a Discard deleted
  lands inside Live's put-back text and spells a discarded word ("s2k" read as "s4k f22k"); no
  character comes back. Two inserts at one gap, open in the gate.

Pins implementation decisions: design §2's grouping (ancestor, `pieces` records written and retired by the
write, comment bodies), the apply record's `seen` from the Live version the writer was shown, the Undo rule per
change with its Live and fork sides as one edit, a change going back whole, put-back text told by
take-back commits, a block `Restore before` takes away going as a removal, and a Work press undone draft by
draft, newest first.
