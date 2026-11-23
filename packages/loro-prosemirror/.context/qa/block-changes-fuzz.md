# Block changes: the press, its Undo, Discard and Restore before

`block-changes-fuzz.probe.ts` runs seeded scripts against `@meridian/document-model`'s
block-change model (`changedBlocks`, `applyBlocks`, `discardBlocks`, `undoPress`, `takeBack`,
`restoreBefore`) and the Undo rule (`take-back.ts`) on the real schema, through the binding's codec, with no stack. Gate 5's fuzz
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

## The copies

Live and its Live tab (a writer typing in Live, synced at random, so a press can meet Live typing
the pressing tab never saw), the fork (the draft's room copy, with its own Live copy) and the Draft
tab (its own copies of both, synced at random; a stale Draft tab goes on typing after a Discard
all). Every Live write in a press goes through the product's own import and restore rule; the
probe never writes a removal or a restore itself. Each press, Discard and Undo runs on a command's own
copy of the fork room and is sent back, as the server runs them, so its writes have fresh peers, and
its changes are stored as JSON and read back.

## Steps

- Writer edits in Draft (text, marks, comments, inline nodes, block inserts, deletes, moves,
  splits, joins, type changes, table rows), Ctrl+Z of the edit just made through `editStays` and
  `takeBack`, AI turns on a copy of
  the fork, and `Restore before` of a turn (`restoreBefore`).
- A press of random changes (`applyBlocks`), carrying as the Live version the writer was shown the
  Live tab's (half the time) or the Changes list's (the server copy's, just read), with Live typing
  the tab never saw and Draft typing landing after it.
- Its Undo (`undoPress`), with Draft typing and Live writes between.
- Dependent presses: 2 to 5 presses over one block, with Live and Draft typing between, undone
  newest first and in random order.
- Live and Draft deletions and replacements over a press's text before its Undo (the later write
  of design §2's text rule), retypes that hold the press's text or are held by it ("house" pressed,
  then "household" or "hous"), and typing right after it, which in a chain is often text a later
  press's Undo put back.
- A Work's `Apply all` over two drafts that both rewrite one paragraph, on a copy of the Live room:
  pressed in draft order, sometimes with Live typing between, and undone draft by draft, newest
  first.
- One-change Discard and its Undo, Discard all and its Undo, and a stale Draft tab across a Discard
  all.

## Checks

- After a press: the chosen changes are no longer pending, unchosen blocks in Live are unchanged,
  pressing again commits nothing, Live typing the tab never saw is in Live and the fork, and Draft
  typing after the press is pending.
- After a press Undo: a change the Undo left (`stayedChanges`: someone wrote over it, design §2's
  four parts) changed nothing in Live or the fork, and with nothing written since the press
  (`quietUndos`) no change stays. Undone in turn with no change left, Live is back to before the
  press when nothing else wrote Live, and the fork reads as before. Out of order, the fork's text in
  every shown block is unchanged.
- **No Undo puts back text a later write removed** (settled rule (a)): where a press's change to a text
  doc was one replacement and a later write removed every character it put in, the press's Undo adds
  no character to that doc (`replacedChecks` in the summary). Whether the press's text is still there
  is decided by character id: its own characters, or ones a take-back commit put back for them
  (`undo {spans}`, followed through earlier take-backs), never by what the text spells.
- After a writer edit: no override this write set equals Live's (including an order override that
  puts the block where Live's key would).
- After the two drafts' Undo: Live is back (or holds the typing between), each draft has only that
  paragraph pending, and no character of either draft's text is lost. When both drafts deleted one
  character, the second press's import deleted it again, so the first press's change stays (part 4
  of the rule, `twoDraftsStayed`): Live keeps the first draft's rewrite, that draft has nothing
  pending, and the second draft still holds its own rewrite.
- After `Restore before`: the fork's text and overrides are what they were before the turn, with
  Live's changes since kept.
- At the end, after `Apply all`: Live, the fork and both tabs converge; nothing is pending; every
  comment mark has its body; no token is duplicated; block ids are unique; no block is pending that
  no write touched, except the accepted copies (below).

## Accepted, and counted rather than failed

Text or marks that a Discard, an Undo or a restore puts back are new operations by the fork, since
Loro has no undelete. A later Live delete or unmark inside that span leaves the fork's copy, which
then shows as a pending change the writer can Discard again (design §1, gate 5's N7). The summary
counts these as `resetCopyObserved`. Text both drafts deleted no longer comes back into a draft:
the first press's change stays (`twoDraftsStayed`), and the check fails if a draft gains text.

**Counted, not accepted:** in the two-drafts case, text the first draft deleted around the second's
rewrite comes back with the first press's Undo as one run of new characters, and Loro may place it on
either side of the second draft's own re-created words (`twoDraftsMoved`, about one two-drafts run in
twelve). No character is lost, but the draft's words read in another order; the check fails on a lost
character only. Design §2's proposed fix (put the text back where the deleted characters were, by a
cursor on them) does not reach it: in the reordered runs the cursor resolves to the index the
transform already uses. The two runs are concurrent inserts at one gap (Live never sees the draft's
re-created words), and Loro orders those itself; an insert by index cannot choose a side.

Pins implementation decisions: design §2's grouping (ancestor, merged sibling order, comment
bodies), the apply record's `seen` from the Live version the writer was shown, the Undo rule per
change with its Live and fork sides as one edit, rule (a) with put-back text told by take-back
commits, a block `Restore before` takes away going as a removal, and a Work press undone draft by
draft, newest first.
