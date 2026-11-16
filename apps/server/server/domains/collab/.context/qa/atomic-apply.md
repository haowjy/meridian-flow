# Atomic frozen Apply

Run from the checkout under review:

```sh
pnpm exec tsx tools/qa/probes/atomic-apply/run.mts
```

The runner creates, migrates, and drops its own `lfd_probe_*` PostgreSQL
database. It drives the production Apply route core with real file policy,
command claim, draft identity, committed live journal, and prefix append. It uses fresh seeded client-1 `review_base` and ProseMirror fragments;
it does not open a browser or network listener.

The runner must pass its frozen Apply, Un-Apply, restore,
receipt, settled answers, replay, queue, rebase, attribution, and rollback cases. In
particular, verify that:

- A frozen click remains fixed while later typing is pending, and its base and
  command record arrive together without changing draft prose.
- Un-Apply reverses intact groups, skips groups edited in live, and replays its
  durable result under the same command id.
- Malformed or overlapping deltas and unknown groups are a 400, an unsynced click a 503, and
  neither claims a command; duplicate ids and changed bodies conflict without claiming the
  wrong action.
- A delayed deletion-only click answers `overtaken` after Discard all; a throw
  after the live half leaves no live effect, base record, claim, or recovery.
- Queued clicks preserve adjacent optimistic changes, a refused predecessor,
  dependent clicks, repeated paragraphs, and another tab's Apply.
- Live writes, deletions, moves, another Work, and a rebase merge with the
  frozen click. Overlapping live words report `overrode`.
- A deleted document is restored by the click, with `restored` on its text half; a taken
  name makes a twin with a distinct path segment.
- A Work's drafted create (in the Work's tree view only, no live row) goes live
  inside its Apply with the same document id and no `branch_tree_nodes` row left;
  a live-deleted document sits in Trash until a click brings it
  back, and a taken name creates a twin with a distinct path segment. The fixtures write the tree
  through `treeListStore.submit` (`test-support/tree-seed.ts`), never by row.

## Late closure at the append door

When changing admission or hold timing, pause `apply.beforeBoundary`, close the
addressed draft through the production close kernel inside its Work boundary,
then resume. Apply must answer `applied` with the item's text half `landed: false` and
`overtaken discarded` naming the Discard, unchanged live text, a stored `done` outcome,
and no room delivery. A previously landed command still wins on retry.
