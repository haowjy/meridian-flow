# Atomic frozen Apply

Run from the checkout under review:

```sh
pnpm exec tsx tools/qa/probes/atomic-apply/run.mts
```

The runner creates, migrates, and drops its own `lfd_probe_*` PostgreSQL
database. It drives the production Apply route core with real file policy,
command claim, draft identity, committed live journal, prefix append, and trail
writer. It uses fresh seeded client-1 `review_base` and ProseMirror fragments;
it does not open a browser or network listener.

The runner must pass its frozen Apply, Un-Apply, restore/`needs_restore`,
receipt, refusal, replay, queue, rebase, attribution, and rollback cases. In
particular, verify that:

- A frozen click remains fixed while later typing is pending, and its base and
  command record arrive together without changing draft prose.
- Un-Apply reverses intact groups, skips groups edited in live, and replays its
  durable result under the same command id.
- Malformed or overlapping deltas, unknown groups, unsynced clicks, duplicate
  ids, and changed bodies refuse or conflict without claiming the wrong action.
- A delayed deletion-only click answers `closed` after Discard all; a throw
  after the live half leaves no live effect, base record, claim, or recovery.
- Queued clicks preserve adjacent optimistic changes, a refused predecessor,
  dependent clicks, repeated paragraphs, and another tab's Apply.
- Live writes, deletions, moves, another Work, and a rebase merge with the
  frozen click. Overlapping live words report `overrode`.
- A deleted document answers `needs_restore` without changing state; a click
  with `restore` restores it, and a taken path returns a `renamed` note.
- Ordinary text Apply does not need the source namespace lock. Hidden-create
  reveal and restore use the tree lock.
- Independent AI receipts retain only their own passages, navigation, and owner
  signals.

## Late closure at the append door

When changing admission or hold timing, pause `apply.beforeBoundary`, close the
addressed draft through the production close kernel inside its Work boundary,
then resume. Apply must answer `closed` with unchanged live text, no command
claim or lineage, and no room delivery. A previously landed command still wins
on retry.
