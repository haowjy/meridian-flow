# client/recents

Device-local account recently-opened documents. This is continuity, not a cache
and not the working-set store. The landing paints this record first. The server
list adds other devices and a newer `openedAt`. It does not delete, overwrite a
known locator, or clear a removal.

- Bind the account before any read. A user mismatch discards the record.
- An open is written here before the record POST. The server's five-second
  interval does not reorder this device. Rank is the later `openedAt`.
- Lists never clear a removal and never delete. Availability is the only removal
  and identity writer besides an open tab. Remember only ids dropped from this
  record; availability batches also contain documents belonging to other consumers.
- One bind epoch fences a cached list across account switches. Do not turn that
  into per-item revisions or an acknowledgement protocol.
- A local draft is a resource handle, not an availability subject. Reopen it
  with the empty-path local address, not a fabricated path and not the by-id
  opener. Document locators are watched; focus, online, and the existing poll
  admit identity. Do not recheck the whole set on catalog cache writes.
- Accepted schemes are manuscript, kb, user, and unfiled. Do not store Work
  identity here. Cap is 50 per account. Do not widen this into a sync engine.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
