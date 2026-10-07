# client/working-set

Device-local recent document routes. Optional server sync provides
cross-device document recency only. Recency can rank already-open Editor tabs;
it never creates workspace membership. Browser-local Editor tabs belong to
`../stores/context-tabs-store/`, and document content belongs to Yjs.

Mental model: a deliberately narrow offline-first reconciler. Local
canonical store (localStorage, userId-stamped, wholesale-discard on user
mismatch); pending-record-existence means unsynced; debounced
whole-snapshot PUTs with revision-checked acks. The server row is the
≤3-route cross-device subset — never the full Editor workspace.

Key rules:

- Server wins on true conflict (base-revision mismatch); local wins on
  plain outage. Recovery paths (PUT failure, shared connectivity retry hints, sync
  re-enable) mark the baseline suspect: fresh GET + the precedence
  reducer before any further push.
- Sync consent fails closed — only a successfully resolved `true`
  enables the driver. The account-lifetime
  `WorkingSetSyncPreferenceProvider` owns the confirmed value and calls
  `configureWorkingSetSync`; the loader prop seeds it only before the first
  local revision, so a stale loader echo cannot re-enable or disable sync.
- Hydration adoption runs once per mounted project identity in the project
  route bootstrap's layout commit, before `ReadableProjectRoute` mounts (and
  once more when a project being created receives its route data). Never
  adopt during render or repeat adoption for same-project loader echoes.
- Build routes with `buildWorkingSetRoute`: every server route requires its
  stable document ID, and Work-capable schemes require explicit real-Work or
  no-Work authority. Never hand-assemble the union.
- Do not grow this into a general sync engine. The narrowness is the
  design. A new state kind gets its own record and policy instead of
  widening this one. Account recently-opened documents are a separate
  Continuity record (`../recents/`), not this store and not a new tier.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md) (contracts and protocol).

The current chat is not working-set state: it is device-local and never
synced (`../current-chat.ts`).
