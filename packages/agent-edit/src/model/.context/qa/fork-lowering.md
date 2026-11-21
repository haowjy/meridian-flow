# Fork lowering: one draft change applied from a fork into Live

`fork-lowering.probe.ts` is the gate for separate draft rooms (direction B in the local-first
design). In direction B a draft is a fork: a second Y.Doc made from Live's update, which keeps
Live's ids and holds the draft's suggestions. Applying one change then means writing into Live
only the structs that change adds or deletes, named by the ids both documents share. The probe
asks whether that lowering can be built on the real schema, through the real binding and
`rewrite`. It is a harness, not shipped code: the lowering, forward, withdraw and Undo live in
the probe file.

## What a run does

Every run starts with 13 fixed cases, one per case the gate names, then runs random scripts.

**Fixed cases.** Each makes its draft edits in a fixed place and must make every one of them (a
skipped edit fails the run). It then applies every pending change in turn: the first with an
Undo and then again, the second draft's last. The cases:

- adjacent new blocks from two changes;
- new blocks in Live containers: after a child, first in a container, in a table cell;
- a new block inside another change's new block;
- inline atoms (an image and a hard break) in a new block;
- a comment on suggested text;
- a split of a Live paragraph;
- a join of two Live list items;
- heading-level, list and removal layers;
- table cell text;
- a new code block, typed in;
- a replace, a deletion inside bold, and a bold, all on Live text;
- two drafts rewording one word;
- a Live peer removing a block while the draft's block beside it is applied.

**Random scripts.**

1. Live starts as a real-schema document: headings, paragraphs with bold and a comment, a
   hard break and an image, a code block, a bullet list, a table, nested `jsx_container`s and a
   horizontal rule. It is written through y-tiptap's `updateYFragment`.
2. The fork is a copy of Live's update. In one script in four a second draft has its own fork,
   and both drafts first reword the same word ("beta" to "ALPHA" and to "BETA").
3. Random draft edits go through `rewrite` in the draft's view and are written to the fork by
   `updateYFragment`. They cover inserts, deletes, replaces and rewords, splits and joins, block
   inserts and deletes, list and unlist, heading level, bold and unbold, images, hard breaks and
   comments. They leave inline `suggest_ins`/`suggest_del`, `sug` blocks, and `sugAttrs` layers
   (levels, lists, removals). Live edits are mixed in and forwarded into the fork.
4. Two rounds of Apply each pick one pending change, lower it into Live, then withdraw it from
   the fork in one fork update.
   - In one round in four a peer makes a structural Live edit before the Apply, merged after it.
     A structural pick that doesn't fit its position types a letter instead, so not every counted
     concurrent edit is structural.
   - In one round in two the Apply is taken back with a composite Undo, with or without the
     concurrent edit.
   - A second draft, when there is one, applies one change last.

A random draft edit is first tried on a copy, and skipped and counted when:

- the draft view would change Live's view (it "leaks");
- it deletes a Live item from the fork ("lost a Live item");
- the binding's diff makes a Live character or block read as the draft's ("swapped").

**The result holds only for the edits that remain.** Swapped and lost-item edits are identity
failures in the fork before any lowering runs. The binding (y-tiptap's `updateYFragment` string
diff) produces them in ordinary typing: " new words " beside a Live space, a bold, a split. A
reviewer ran with only leaked edits skipped (seed 1, 1,000 scripts) and the lowering's checks
failed on them: identity 146 of 2,219, accepted view 86, fork Live view 85. Today's one-document
model takes the same binding write into Live itself, so the swap is not B's alone. But B can't
hold every draft edit until a binding write keeps Live ids in the fork. The skipped table below
gives the rates.

## Assertions

Before each Apply:

- the fork's Live view equals Live.

After each Apply, Live against the oracle (a copy of the fork with the change accepted by
`resolveStored(..., "accept")`, read in Live's view):

- the fork deleted no Live item and holds no text no change owns;
- Live equals the accepted view;
- Live loses exactly the items the accept deletes, and every other Live item keeps its id;
- Live holds no fork-client struct, no suggestion mark, no `sug` or `sugAttrs` and no fork-only
  map entry;
- Live's new characters and nodes are the accepted edit's, from one client;
- Live's new attribute, format and text items are bounded by the accepted edit:
  - one attribute item per attribute of a new element and per attribute whose value changed;
  - at most two format items per attribute that differs across each boundary of new text,
    deleted neighbours included;
  - one text item per new text that holds something;
- Live deletes no format or attribute item the accept leaves as it was. A format item may go in a
  text the accept deleted from, because Yjs drops formats a deletion leaves redundant.

After the withdraw, the fork against the same oracle:

- the fork's Live view equals Live;
- the fork's draft view equals the accepted copy's;
- the fork's stored document (marks and all) and its pending changes equal the accepted copy's;
- the change has nothing pending;
- a Draft tab given only the one fork update matches the fork, with no pending structs.

With a concurrent Live edit, Live and the peer converge, the fork's Live view equals Live, and
Live holds nothing of the fork.

With two drafts:

- the other fork's Live view equals Live after the Apply;
- the other draft keeps every pending suggestion, by unit and mark, that Live didn't take away;
- the first fork's Live view equals Live after the other draft's Apply.

A suggestion counts as taken away when its text was Live text the Apply deleted, or it sat in a
Live block the Apply removed. Both are counted, not failed: see Open questions.

After an Undo:

- the fork's Live view equals Live;
- Live equals Live before the Apply, plus the concurrent edit if there was one;
- the fork's stored document and pending changes equal the fork before the Apply, plus the
  concurrent edit forwarded, with the change pending again;
- the verdicts map is as before;
- Live holds nothing of the fork;
- the other fork, if any, reads Live.

When the peer's edit reached what the Apply deleted, the "plus the concurrent edit" checks are
skipped and counted. In that case the peer deleted the same items, or wrote inside a block the
Apply removed, and Yjs settles the two as it would for two Live clients in one document.

Each failure prints the script and the replay: `FUZZ_SEED=<seed> FUZZ_ONLY=<script>`, or
`FUZZ_CASE=<n>` for a fixed case.

## Run

```bash
cd packages/agent-edit
pnpm exec vitest run --config src/model/.context/qa/fork-lowering.vitest.config.ts
FUZZ_SEED=3 FUZZ_SCRIPTS=1000 pnpm exec vitest run --config src/model/.context/qa/fork-lowering.vitest.config.ts
```

- `FUZZ_SCRIPTS` sets the script count (default 300). 1,000 scripts take about 40 s.
- `FUZZ_SEED` picks the seed (mulberry32, seeded per script as `seed + index * 7919`).
- `FUZZ_ONLY=<n>` runs one script and no fixed cases.
- `FUZZ_CASE=<n>` runs one fixed case and no scripts.
- `FUZZ_VERBOSE=1` prints each Apply's documents and the peer's edit.
- `FUZZ_TRACE=1` prints the first divergence after each step.
- `FUZZ_DUMP=<text>` dumps the Yjs items of the text holding it.

The run prints one JSON line of counts, a pass/fail count per assertion with the first failure,
the draft edits made and skipped by kind and block, and the bytes per applied character.

## What the lowering needed beyond the Yjs probe

The plain-Yjs probe (`s2-fork.mjs`) copied a change's insertions and deletions by id. On the
real document model it also needed:

- **Copy from the accepted copy.** Walk F' (the fork with the change accepted) beside the fork
  and Live. Copy into Live only units that read as Live in F': a change typed inside another
  change's insertion stays pending.
- **Anchor on visible Live units.** A Yjs index insert skips deleted runs, so every anchor and
  gap is keyed on the nearest Live unit that stays visible.
- **Write each Live run once.** Where another change's hidden insertion splits a copied text, the
  pieces that read as one run in Live are written in one insert. Otherwise each piece adds its
  own format items.
- **Withdraw = delete own copies + accept.** The withdraw deletes the fork-only items Live now
  has copies of, then accepts the change in the fork. Rejecting would bring back other
  changes' text the change struck.
- **Re-place other changes' content.** Another change's fork-only content that shared a gap
  with the copied text is made again, in the fork's order, around Live's copies.
- **Dress Live's copies.** Other changes' marks, text, blocks and layers that sat on or in the
  copied fork content are laid back onto Live's copies.
- **A fix-up after every forward.**
  - Yjs formats are positional: a format item covers whatever the other document puts in its
    range. After a forward, Live characters in each touched text are set to Live's
    non-suggestion attributes, and fork-only characters keep the attributes they had.
  - A text counts as touched when the forwarded update adds an item to it or deletes one in it:
    deleting Live's format item can uncover a fork one.
  - The withdraw and the Undo run the fix-up again over every text after their own writes.
- **Undo.**
  - Undo Live, forward that update, then undo the fork.
  - Re-strike the restored Live items with their recorded suggestion marks, found through the
    `item.redone` chain.
  - Lay removed blocks' fork content back from a copy of the fork before the Apply.
  - Make the fork-only content again in its old order: restored items are ordered by client id.
  - Give restored fork text its attributes from before the Apply.

Each walk is over the whole document, or every touched text, on each forward. A product
version would need to bound that.

## Open questions

These are for the B design to settle; the probe counts them instead of failing.

- **Another draft's suggestions inside a block the Apply removes go with it.** When draft A's
  change removes a Live block, draft B's pending insertions inside it are deleted with the
  block. B gets no notice and nothing to take back. Over 12,000 scripts: 696 units, out of 5,966
  two-draft Applies. Today's one-document model does the same: `resolve.ts` deletes an accepted
  removal's whole block. B's own suggestions on Live text the Apply deleted (6,000 units) are
  moot, not lost.
- **Undo after a concurrent edit that reached the applied content.** In 82 of 2,696 Undos after
  a concurrent edit, the peer had deleted the same items or written inside a removed block. An
  example: the peer joins a paragraph into a heading the Apply removes. The joined text then
  lands in a deleted block and is gone from Live before any Undo, as between two Live clients
  today. The fork still agrees with Live after the Undo.
- **The Undo needs more than the two id-range sets.** It also reads a copy of the fork from
  before the Apply (to restore order, removed blocks' fork content and fork text attributes), and
  the struck marks of the Live items the Apply deleted. A product press record would have to
  store that.
- **The fix-up reads Live's document.** It sets Live characters in the fork to Live's attributes
  by looking them up in Live. A rule local to the fork, such as each change's mark-time state
  vector, is not what this probe proves.
- **Draft edits the fork can't hold as suggestions.** See the skipped table: images, hard breaks
  and comments placed in Live text, typing in a Live code block, most joins of Live blocks, and
  the binding's swaps and lost items. The fixed cases show the lowering for each of these where
  the edit can be held: atoms and a code block inside a new block, a comment on suggested text,
  one split and one join.
- The random edits come from this harness's own generator, not from the POC's scripts.

## Last run: 2026-11-20, on `feat/suggestions-bg-gate` 50dbf59a7b

Seeds 1 to 12, 1,000 scripts each, plus the 13 fixed cases in every run (measured on the code of 50dbf59a7b; that commit changed only the probe's header comment after the run). That makes 26,899
Applies, 12,010 Undos (2,696 after a concurrent edit), 5,966 two-draft checks and 5,252
concurrent Live edits. Every assertion passed. The median Live update was about 18.5 bytes per
applied character, the largest 129.

Each bug below was put back by hand to check that the probe catches it, on seed 1 with 300
scripts unless named:

| Removed or added | Fails |
| --- | --- |
| reject all of the other draft's changes after the Apply | 60 of 113 two-draft checks |
| the lowering re-sets every Live attribute | every Apply |
| the lowering adds and deletes a Live map entry | every Apply (attribute items) |
| the lowering formats and unformats Live text | 610 of 684 Applies |
| writing each Live run once | 2 of 26,899 Applies over 12 seeds; none at 300 scripts |
| the fix-up | at once (before the review round) |
| re-placing other changes' content | 16 of 666 Applies (before) |
| dressing Live's copies | 3 of 666 (before) |
| withdraw as reject | 4 of 667 (before) |
| restoring order on Undo | 6 of 728 Undos, seed 3, 1,000 scripts (before) |
| deletions counting as touched | seed 8 script 84 (before) |
| restored fork text keeping its attributes | seeds 3, 6, 9: one Undo in about 750 (before) |

### Draft edits skipped in random scripts, 12,000 scripts

| Edit | Made | Skipped | Why |
| --- | --- | --- | --- |
| image | 64 | 4,572 leaked | an inline atom carries no marks, so the draft's image in Live text reads as Live's |
| hard break | 74 | 4,584 leaked | the same |
| comment | 55 | 2,599 leaked | a comment on Live text shows in Live's view |
| insert | 32,966 | 2,690 leaked (2,660 in code blocks), 346 swapped | code block text takes no marks; the binding's diff matches Live's equal character to the draft's |
| join | 2,008 | 960 leaked | joining into a Live block changes it outside any layer |
| split | 4,411 | 640 lost a Live item | the binding rebuilds the split block's tail |
| bold, unbold | 2,256 | 193 leaked, 222 swapped, 7 lost | as for insert |
| replace, reword | 5,920 | 527 leaked (440 in code blocks), 28 lost, 3 swapped | as for insert |

A draft-made image, hard break or comment lands in a random script only about 60 times in
12,000, so the fixed cases carry those. The leaked edits are what `rewrite` can't express as a
suggestion: in today's one-document model its output for them is the stored document, so the
same edit would read as Live there too. That reading of today's product is not checked in a
browser.
