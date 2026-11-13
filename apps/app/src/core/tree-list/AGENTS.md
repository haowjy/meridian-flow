# core/tree-list

The browser's copy of a project's tree list (or the account's, for `user://`): a Yjs document
plus its sync status, per list, per account. Step 6's tree screens read it; no screen does yet.

- Read a list through `TreeListRegistry.acquire` (owned by `AccountFeatureLifetime.treeLists`) and
  its session's `getSnapshot()`. After a rebuild the snapshot's `doc` is a new document: never
  hold one across a render.
- The copy is stored in `y-indexeddb` and shared by the tabs. One tab owns the connection (a Web
  Lock); the others follow it over a `BroadcastChannel`. Every tab session has a Yjs client id of
  its own: a fresh `Y.Doc`, never one reused from storage.
- A rebuild opens the next stored database and deletes the old one once every tab has let go
  (`StoredListCopy.replace`): deleting the database a peer has just opened blocks forever.
- Resolve an address only when the status is `synced` or `offline`; `waiting` is "waiting for
  the list", not "not there".
- `window.__meridianTreeList` (dev builds) opens a list and reads its replay for a browser run.

State machine: [.context/state-machines.md](.context/state-machines.md).
