# client/recents

Device-local account continuity for recently opened documents. It is not a cache,
working set or sync engine.

- Write an open before its server request. Rank by the later `openedAt`, so the
  server's batching interval can't reorder this device.
- Keep one account bind epoch for the cached list. Don't grow this into item
  revisions or an acknowledgement protocol.
- Local drafts reopen through their empty-path handle, not a fabricated path or
  by-ID opener. Don't store Work identity.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
