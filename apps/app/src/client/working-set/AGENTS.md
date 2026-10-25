# client/working-set

Device-local recent document routes with optional cross-device sync. It can rank
already-open Editor tabs but never creates workspace membership; Editor tabs and
Yjs content have separate owners.

## Rules

- The local store is user-stamped and is discarded wholesale on user mismatch.
  Pending record existence means unsynced. Sync uses debounced whole-snapshot
  PUTs with revision-checked acknowledgements.
- A true revision conflict lets the server win; an outage lets local state stay
  visible. After PUT failure, connectivity retry, or re-enabling sync, GET a
  fresh baseline and run the precedence reducer before pushing again.
- Sync consent fails closed. `AccountSettingsProvider` owns the confirmed value
  and calls `configureWorkingSetSync`; pending or failed choices are display
  state only and are never relayed or cached as confirmed.
- Adopt once per mounted project identity during route bootstrap, before route
  parsing; never adopt during render or for repeated loader echoes.
- Build routes with `buildWorkingSetRoute`. Every server route requires its
  stable document ID, and Work-capable schemes require real
  Work or No Work authority; No Work Scratch carries its lineage instead of a
  Work. Do not hand-assemble the union.
- Recently opened documents belong to `../recents/`, and current chat is
  device-local and unsynced; neither is working-set state.
- The server row is only the cross-device subset of at most three routes, never
  the full Editor workspace. Do not grow this into a general sync engine: the
  narrowness is the design, and a new state kind gets its own record and policy.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md) (contracts and protocol). Deferred driver lifetime work is in [.context/TODO.md](.context/TODO.md).
