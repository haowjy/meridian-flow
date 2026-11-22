# core/tree-list

The browser's copy of a project's tree list (or the account's, for `user://`): a `LoroDoc`
plus its sync status, per list, per account. Every screen that shows a name or a place reads it
through `client/query/useProjectTree.ts` (a source's tree from the replay) and writes it through
`core/project-tree/tree-actions.ts` (records appended to this copy).

- Read a list through `TreeListRegistry.acquire` (owned by `AccountFeatureLifetime.treeLists`) and
  its session's `getSnapshot()`. After the copy is replaced the snapshot's `doc` is a new document: never
  hold one across a render.
- The copy is stored per list in IndexedDB (`core/editor/local-copy-store.ts`: a snapshot and a
  log of envelope batches) and joined to the list's room on `/ws/loro` by each tab itself, under a
  fresh peer id. Local writes are stored, posted to the other tabs over a `BroadcastChannel`, and
  sent; peers' batches are imported and stored. A Join that names another list replaces the copy
  with an empty one (state machine below).
- Resolve an address only when the status is `synced`, `offline` or `broken`; `waiting` is
  "waiting for the list", not "not there". The snapshot's `version` counts changes to the copy:
  `session.replay(view)` is a view's replay (live by default, or live then a Work's pending records) once per version, shared by every reader. Each session
  the registry opens is watched for the server bouncing the account's own records
  (`core/project-tree/tree-bounces.ts`): a `dropped` stamp that arrives after the stored copy was read.
- Closing a session destroys its transport and frees its docs, the replaced ones included.
- `window.__meridianTreeList` (dev builds) opens a list and reads its replay for a browser run.

State machine: [.context/state-machines.md](.context/state-machines.md).
