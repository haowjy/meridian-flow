# client/working-set

Device-local recent document routes and remembered thread, with optional server
sync for cross-device continuity. Recency can rank already-open Editor tabs; it
never creates workspace membership. Browser-local Editor tabs belong to
`../stores/context-tabs-store/`, and document content belongs to Yjs.

Mental model: a deliberately narrow offline-first reconciler. Local
canonical store (localStorage, userId-stamped, wholesale-discard on user
mismatch); pending-record-existence means unsynced; debounced
whole-snapshot PUTs with revision-checked acks. The server row is the
≤3-route cross-device subset — never the full Editor workspace.

Key rules:

- Server wins on true conflict (base-revision mismatch); local wins on
  plain outage. Recovery paths (PUT failure, offline→online, sync
  re-enable) mark the baseline suspect: fresh GET + the precedence
  reducer before any further push.
- Sync consent fails closed — only a successfully resolved `true`
  enables the driver. The account-lifetime
  `WorkingSetSyncPreferenceProvider` owns the confirmed value and calls
  `configureWorkingSetSync`; the loader prop seeds it only before the first
  local revision, so a stale loader echo cannot re-enable or disable sync.
- Hydration adoption is synchronous render-time state, keyed by
  projectId. Never adopt via effects.
- Build routes with `buildWorkingSetRoute`: every server route requires its
  stable document ID, and Work-capable schemes require explicit real-Work or
  no-Work authority. Never hand-assemble the union.
- Do not grow this into a general sync engine. The narrowness is the
  design. A new state kind gets its own record and policy instead of
  widening this one. Account recently-opened documents are a separate
  Continuity record (`../recents/`), not this store and not a new tier.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md) (contracts and protocol).
