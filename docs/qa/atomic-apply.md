# Atomic frozen Apply

Run from the checkout under review:

```sh
pnpm exec tsx tools/qa/probes/atomic-apply/run.mts
```

The runner creates, migrates and drops its own `lfd_probe_*` PostgreSQL database.
It calls the production Apply HTTP route core with the real file policy,
command lookup/claim, draft identity resolver, committed live journal, prefix
append and trail writer. It does not open a browser or a network listener.
The writer/model fixtures use the production fresh seed with independent
client-1 `review_base` and `prosemirror` fragments. Rebase-gap
fixtures author both fragments through the shared server append door using the
kernel; they do not certify the replacement rebase scheduler.

## Covered risks

- Frozen text stays fixed while later typing remains pending; the Apply base
  and command record arrive in one row, without changing the draft prose.
- Un-Apply reverses intact text groups, skips a group edited later in live, and
  removes a null-live receipt without reopening a draft difference. Its durable
  result replays under the same command id.
- Malformed/overlapping deltas and unknown groups claim nothing; a different
  body under a landed id conflicts. A clicked key not yet durable refuses
  `unsynced`, then the same click lands once acknowledged.
- A duplicate and a paused original produce one lineage and return their own
  stored outcome. A landed retry remains `applied` after the draft closes.
- A delayed deletion-only click answers `closed` after production Discard all
  and replacement-draft creation, even when the replacement repeats the same
  client-1 clocks and deletion. Live remains unchanged.
- A throw after the live half leaves no live effect, base record, claim or room
  recovery; same-id retry then executes once.
- Pending optimistic bases preserve adjacent clicks, a refused predecessor,
  three dependent clicks, repeated paragraphs and another tab's Apply.
- Live writes/deletions, another Work, paragraph moves and a rebase in the gap
  merge with the frozen click. Overlapping live words report `overrode`; the
  next synthetic rebase leaves the base equal to live.
- A one-second 40-keys/s target and 520 total frames do not move the clicked cut.
  The runner prints the achieved rate rather than assuming it reached the target.
- A document deleted live keeps its active draft. A click without `restore`
  answers `needs_restore`, changes nothing and replays the same answer; a click
  with `restore` restores it, merges, answers `applied` with `restored: true`,
  and the replay returns the same result. A delete between Apply's unlocked scope
  guess and its lock (`apply.afterScopeGuess`) retries namespace-first and still
  restores. A delete after compilation (`apply.beforeBoundary`) of a click sent
  while the document was living answers `needs_restore`. A path a new document
  took restores the draft at the next free name and returns a `renamed` note. A branch that also holds an
  unrelated hidden creation still reads the addressed document's own state and
  restores it. A hidden creation is revealed
  in the transaction without replacing its identity.
- Ordinary text Apply completes while another transaction holds the source
  namespace. Only a hidden-create reveal or a restore needs that tree lock.
- Two AI conversations applied in one click each retain only their own passage
  in durable owning-turn receipts. Rows cover independent paragraphs, a live
  move, a selected draft move, shared-paragraph authorship, deletion and an
  unrelated multi-paragraph replacement. Every recorded change has navigation;
  the other author's unrelated prose is absent.
- An AI receipt's membership supplies committed live before/after trail text,
  navigation and explicit owner dirty signals.

## Late closure at the append door

When changing admission or hold timing, also probe a closure after compilation:
pause `apply.beforeBoundary`, close the addressed draft through the production
close kernel inside its Work boundary, then resume. Apply may stage its live
half, but must answer `closed` with unchanged durable live text, no command
claim or lineage, and no room delivery. A previously landed command still wins
on retry. This checks the rollback boundary rather than an early status read.

## Writer confirmation

After integrating the browser command owner and fresh seed/rebase, use
[draft review](draft-review.md) on a fresh stack pinned to the integration
commit. Click Apply while typing, make a second click beside the pending one,
then repeat after moving the paragraph and after a local Discard/Undo. Check
that only the frozen words reach live and that the review never resurrects an
already recorded click. Capture screenshots and independently read live and
both draft fragments. API-core probe success is not evidence for that UI flow.

For drafted name swaps and chains, also run the model move recipe's Apply case. Check the branch
after the draft, after card Undo, and after Redo: each state has distinct visible names, and Redo
restores every requested name. Apply must then use the exact swap or chain, without introducing
a suffix. Read each live document independently to prove its content followed the intended name.
