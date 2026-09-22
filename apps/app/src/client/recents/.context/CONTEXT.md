# Account recents

`DeviceAccountRecentsStore` is the account-stamped localStorage record. The
browser module binds it once per authenticated render, the same way the working
set does, and refuses a mismatched account before any read.

A list applies only for the account bind that started it. `bindEpoch` is that
fence: one number, bumped when the bound user changes, captured on the fetch,
and checked before the payload is merged. It is not stored, and it is not an
item revision.

- An existing row keeps its name and path. A newer server `openedAt` is adopted.
  An older or equal one is not. Absence does not delete.
- A removal is a document id until a local open of that id. A list cannot clear
  it and cannot import it. The set is capped at 50; the oldest removal this
  record actually held may fall off. That cap is not a list-driven clear.
  `applyAvailability` currently also appends commands for documents this record
  does not hold. Those ids can evict a real removal, and the next list imports
  it. Absence will not delete it again. Remember only ids dropped from this
  record in that call, including an unreadable address. Do not grow an unbounded
  log, and do not let a list delete to paper over the miss.
- Availability admits deletion, access loss, and a later locator. An open tab
  does the same for a row still in the record, including a local draft's name.
- A local handle is not watched. A document locator is. Never-admitted
  `not-visible` is already a non-removal in the availability coordinator, so
  this record does not keep an admission flag. Do not recheck every recent on
  a catalog cache write; focus, online, and the existing poll cover the watch.

Project slugs are read from their catalogs at navigation time. The record stores
the document locator, not a second catalog.
