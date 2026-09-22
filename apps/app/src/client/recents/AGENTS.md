# client/recents

Device-local account recently-opened documents. This is continuity, not a cache
and not the working-set store. The landing paints this record first. The server
list adds other devices and must not demote an opening this device ranked later.

- Bind the account before any read. A user mismatch discards the record.
- An open is written here before the record POST. The server's five-second
  interval does not reorder this device.
- A list cannot erase or demote an opening it started before, or a row the
  server has not acknowledged. `recorded: false` means the row did not move,
  not that the opening failed.
- Deletion, access loss, and later identity come through availability. Do not
  sprinkle recents updates across mutation sites, and do not copy the project
  or Work catalog into this record.
- A local draft is a resource handle. Reopen it with the empty-path local
  address, not a fabricated path and not the by-id opener.
- Cap is 50 per account. Do not widen this into a sync engine.

Depth: [.context/CONTEXT.md](.context/CONTEXT.md).
