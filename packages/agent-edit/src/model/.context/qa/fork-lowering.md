# Fork lowering: one draft change applied from a fork into Live

`fork-lowering.probe.ts` is the gate for separate draft rooms (direction B in the local-first
design). In direction B a draft is a fork: a second Y.Doc made from Live's update, which keeps
Live's ids and holds the draft's suggestions. Applying one change then means writing into Live
only the structs that change adds or deletes, named by the ids both documents share. The probe
asks whether that lowering can be built on the real schema, through the real binding and
`rewrite`. It is a harness, not shipped code: the lowering, forward, withdraw and Undo live in
the probe file.

## What one script does

1. Live starts as a real-schema document: headings, paragraphs with bold and a comment, a
   hard break and an image, a code block, a bullet list, a table, nested `jsx_container`s and a
   horizontal rule. It is written through y-tiptap's `updateYFragment`.
2. The fork is a copy of Live's update. In one script in four a second draft has its own fork,
   and both drafts first reword the same word ("beta" to "ALPHA" and to "BETA").
3. Random draft edits go through `rewrite` in the draft's view and are written to the fork by
   `updateYFragment`: inserts, deletes, replaces and rewords, splits and joins, block inserts and
   deletes, list and unlist, heading level, bold and unbold, images, hard breaks and comments.
   They leave inline `suggest_ins`/`suggest_del`, `sug` blocks, and `sugAttrs` layers (levels,
   lists, removals). Live edits made by a peer are mixed in and forwarded into the fork.
4. Two rounds of Apply pick one pending change and lower it into Live, then withdraw it from the
   fork in one fork update. In one round in four a peer makes a structural Live edit before the
   Apply, merged after it. In one round in two the Apply is taken back with a composite Undo
   from the two recorded id-range sets. A second draft, when there is one, then applies too.

Each draft edit is first tried on a copy. An edit is skipped and counted when the draft view
would change Live's view (it "leaks"), when it deletes a Live item from the fork, or when the
binding's diff makes a Live character or block read as the draft's ("swapped"). These are
limits of the fork's edit model, not of the lowering: see the skipped table below.

## Assertions

Before each Apply:

- the fork's Live view equals Live.

After each Apply:

- the fork deleted no Live item and holds no text no change owns;
- Live equals the fork's accepted view of the change (`resolveStored(..., "accept")` on a copy,
  read in Live's view);
- Live loses exactly the items the accept deletes, and every other Live item keeps its id;
- Live holds no fork-client struct, no suggestion mark, no `sug` or `sugAttrs` and no fork-only
  map entry;
- Live's new structs are the accepted edit's: characters and nodes from one client, nothing else;
- after the withdraw, the fork's Live view equals Live;
- the fork's draft view equals its view before, with the change applied;
- the change has nothing pending in the fork, and the fork holds no pending structs of it;
- a Draft tab that receives only the one withdraw update matches the fork.

With a concurrent Live edit: Live and the peer converge, the fork's Live view equals Live, and
Live holds nothing of the fork. With two drafts: the other fork's Live view equals Live after
the Apply, and the other draft loses no pending insertion.

After an Undo: Live equals Live before the Apply, the fork's stored document (marks and all)
equals the fork before, the verdicts map equals before, the change is pending again, and Live
holds nothing of the fork.

Each failure prints the script and `FUZZ_SEED=<seed> FUZZ_ONLY=<script>`, which replays it.

## Run

```bash
cd packages/agent-edit
pnpm exec vitest run --config src/model/.context/qa/fork-lowering.vitest.config.ts
FUZZ_SEED=3 FUZZ_SCRIPTS=1000 pnpm exec vitest run --config src/model/.context/qa/fork-lowering.vitest.config.ts
```

- `FUZZ_SCRIPTS` sets the script count (default 300). 1,000 scripts take about 40 s.
- `FUZZ_SEED` picks the seed (mulberry32, seeded per script as `seed + index * 7919`).
- `FUZZ_ONLY=<n>` runs one script.
- `FUZZ_VERBOSE=1` prints each step and outline.
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

## Last run: 2026-11-20, on `feat/suggestions` c59d44807a

Seeds 1 to 12, 1,000 scripts each: 26,472 Applies, 9,170 Undos, 6,100 two-draft checks and
5,134 concurrent Live edits. Every assertion passed. "Before the press" was checked 15,073 times
(once per draft per script). The median withdraw update was about 19 bytes per applied
character, the largest 155.

Each bug below was put back by hand to check that the probe catches it:

| Removed | Fails |
| --- | --- |
| the fix-up | at once |
| re-placing other changes' content | 16 of 666 Applies |
| dressing Live's copies | 3 of 666 |
| withdraw as reject | 4 of 667 |
| restoring order on Undo | 6 of 728 Undos (seed 3) |
| deletions counting as touched | seed 8 script 84 (precondition after a Live split) |
| restored fork text keeping its attributes | seeds 3, 6, 9 (one Undo in about 750 each) |

### Draft edits skipped, 12,000 scripts

| Edit | Skipped | Why |
| --- | --- | --- |
| image | 4,614 leaked (61 made) | an inline atom carries no marks, so the draft's image reads as Live's |
| hard break | 4,602 leaked (69 made) | the same |
| comment | 2,592 leaked (61 made) | a comment on Live text shows in Live's view |
| insert | 2,630 leaked, 2,612 of them in code blocks; 377 swapped | code block text takes no marks; the binding's diff matches Live's equal character to the draft's |
| join | 956 leaked | joining into a Live block changes its attributes outside any layer |
| split | 616 lost a Live item | the binding rebuilds the split block's tail |
| bold, unbold | 193 leaked, 199 swapped | as for insert |
| replace, reword | 498 leaked, mostly in code blocks | as for insert |

Each of these is a draft edit that can't be held as a suggestion in the fork. Direction B has to
decide each one, for example by writing it to Live directly or blocking it in the draft view,
before the fork holds every draft edit. A draft-made image, hard break or comment lands only
about 60 times in 12,000 scripts, so the lowering of those is thinly covered. Comments on
suggested text come mostly from the inserted blocks, each of which carries one.
