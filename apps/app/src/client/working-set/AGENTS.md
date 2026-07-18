# client/working-set

Device-local working-set state and its server sync: which documents and
thread a writer had open, kept as a small per-user·project continuity
record so another device can resume where they left off. This module is
NOT the tab desk (that's `../stores/context-tabs-store/`) and NOT document
content (that's Yjs).

Mental model: a deliberately narrow offline-first reconciler. Local
canonical store (localStorage, userId-stamped, wholesale-discard on user
mismatch); pending-record-existence means unsynced; debounced
whole-snapshot PUTs with revision-checked acks. The server row is the
≤3-route cross-device subset — never the full desk.

Key rules:

- Server wins on true conflict (base-revision mismatch); local wins on
  plain outage. Recovery paths (PUT failure, offline→online, sync
  re-enable) mark the baseline suspect: fresh GET + the precedence
  reducer before any further push.
- Sync consent fails closed — only a successfully resolved `true`
  enables the driver.
- Hydration adoption is synchronous render-time state, keyed by
  projectId. Never adopt via effects.
- Build routes with `buildWorkingSetRoute` (work-scoped schemes require
  a workId); never hand-assemble the union.
- Do not grow this into a general sync engine — the narrowness is the
  design. If a new state kind needs syncing, give it its own tier and
  policy instead of widening this record.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md) (contracts, protocol),
[.context/DECISIONS.md](.context/DECISIONS.md) (rulings and rejected
alternatives).
