# core/tree-list

The browser's copy of a project's tree list (or the account's, for `user://`): a Yjs document
plus its sync status, per list, per account. Every screen that shows a name or a place reads it
through `client/query/useProjectTree.ts` (a source's tree from the replay) and writes it through
`core/project-tree/tree-actions.ts` (records appended to this copy).

- Read a list through `TreeListRegistry.acquire` (owned by `AccountFeatureLifetime.treeLists`) and
  its session's `getSnapshot()`. After a rebuild the snapshot's `doc` is a new document: never
  hold one across a render.
- The copy is stored in `y-indexeddb` and shared by the tabs. One tab owns the connection (a Web
  Lock); the others follow it over a `BroadcastChannel`. Every tab session has a Yjs client id of
  its own: a fresh `Y.Doc`, never one reused from storage.
- A rebuild opens the next stored database, stores the records it carries in it (the `carried`
  key), and only then retires the old one once every tab has let go (`StoredListCopy.replace`):
  deleting the database a peer has just opened blocks forever, and retiring the old one first
  loses the records no one has appended yet. Every message between tabs names its generation; a
  follower that hears the rebuild rewrites what it wrote that the owner did not carry.
- Resolve an address only when the status is `synced`, `read-only` or `offline`; `waiting` is
  "waiting for the list", not "not there". The snapshot's `version` counts changes to the copy:
  `session.replay()` is the live replay once per version, shared by every reader. The snapshot's `rejected` holds records the server
  refused until they were given up on.
- Closing a session cancels its queued lock request, and the connection lives exactly as long as
  the lock callback.
- `window.__meridianTreeList` (dev builds) opens a list and reads its replay for a browser run.

State machine: [.context/state-machines.md](.context/state-machines.md).
