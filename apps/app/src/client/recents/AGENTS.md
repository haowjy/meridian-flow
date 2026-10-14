# client/recents

Device-local account continuity for recently opened documents. It is not a
cache, working set, or sync engine: local records paint first, while server
results add other-device recency without erasing known locators or removals.

- Bind the account before reading; a user mismatch discards the record.
- Write an open before its server request. Rank by the later `openedAt`; the
  server's batching interval must not reorder this device.
- Only availability removes a locator. Remember only IDs in this record, and
  do not recheck the whole set on catalog cache writes.
- Keep one account bind epoch for the cached list. Do not grow this into item
  revisions or an acknowledgement protocol.
- Local drafts reopen through their empty-path handle, not a fabricated path or
  by-ID opener. Accepted schemes are manuscript, kb, user, and unfiled; never
  store Work identity. The cap is 50 per account.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).

The context file covers the account epoch and availability ordering in depth.
