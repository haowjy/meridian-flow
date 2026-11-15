# core/tree-list

The browser's copy of a project's tree list (or the account's, for `user://`): a Yjs document
plus its sync status, per list, per account. Every screen that shows a name or a place reads it
through `client/query/useProjectTree.ts` (a source's tree from the replay) and writes it through
`core/project-tree/tree-actions.ts` (records appended to this copy).

- Read a list through `TreeListRegistry.acquire` (owned by `AccountFeatureLifetime.treeLists`) and
  its session's `getSnapshot()`. After the copy is replaced the snapshot's `doc` is a new document: never
  hold one across a render.
- The copy is stored in `y-indexeddb` and shared by the tabs. One tab owns the connection (a Web
  Lock); the others follow it over a `BroadcastChannel`. Every tab session has a Yjs client id of
  its own: a fresh `Y.Doc`, never one reused from storage.
- A replacement (the server broke the connection, or named another list) opens the next stored
  database, stores the records it carries and the id of the list the copy is of in it (the
  `carried` and `list` keys), and only then retires the old one once every tab has let go
  (`StoredListCopy.replace`):
  deleting the database a peer has just opened blocks forever, and retiring the old one first
  loses the records no one has appended yet. Every message between tabs names its generation. The
  reset names the list and how the copy started over: after a recovery a follower rewrites what it
  wrote that the owner did not carry (through `clientMayWrite`); after a discard (another list) it
  rewrites nothing, or the old list's records would come back into the new one.
- Resolve an address only when the status is `synced`, `offline` or `broken`; `waiting` is
  "waiting for the list", not "not there". The snapshot's `version` counts changes to the copy:
  `session.replay(view)` is a view's replay (live by default, or live then a Work's pending records) once per version, shared by every reader. The registry's `onDropped` is told the records a
  recovered copy left out because this build of the client never writes them (one toast). Each session
  the registry opens is watched for the server bouncing the account's own records
  (`core/project-tree/tree-bounces.ts`): a `dropped` stamp that arrives after the stored copy was read.
- Closing a session cancels its queued lock request, and the connection lives exactly as long as
  the lock callback.
- `window.__meridianTreeList` (dev builds) opens a list and reads its replay for a browser run.

State machine: [.context/state-machines.md](.context/state-machines.md).
