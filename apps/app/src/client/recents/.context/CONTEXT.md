# Account recents

`DeviceAccountRecentsStore` is the account-stamped localStorage record. The
browser module binds it once per authenticated render, the same way the working
set does, and refuses a mismatched account before any read.

Each item carries the revision of its last local open or locator write, and the
revision at which a response proved the server has the row. A list applies only
to the account that started it.

- If the item's revision is newer than the list's captured revision, the list
  cannot change that item.
- Absence drops an item only after acknowledgement, and only when the list
  started at or after that acknowledgement.
- A removal tombstone blocks every later list from putting that row back
  until a list for the same project, started after the removal, no longer
  contains it.
- Server `openedAt` is adopted only when it is newer. An unchanged server row
  leaves the local opening where the writer put it.
- The list does not overwrite a local name or path. Availability and the open
  tab do that. A list that started before that write is fenced by the revision.

Project and Work slugs are read from their catalogs at navigation time. The
record stores the document locator, not a second catalog.
