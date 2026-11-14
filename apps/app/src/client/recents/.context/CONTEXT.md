# Account recents

- A removal is a document id until a local open of that id. A list can't clear or
  import it. The oldest removal this record actually held may fall off the cap,
  which isn't a list-driven clear. `applyAvailability` remembers only ids dropped
  from this record in that call, so unrelated availability commands don't consume
  removal capacity.
- A reversible create Undo stores the removed recent with its tombstone. Redo
  restores the row at its original `openedAt`, updating only the document's
  current name and address, so reversal doesn't make an old document recent.
- Availability admits deletion, access loss and a later locator. A presented document
  does the same for a row still in the record, including a local draft's name.
- A local handle isn't watched; a document locator is. Never-admitted
  `not-visible` is already a non-removal in the availability coordinator, so this
  record keeps no admission flag. Focus, online and the existing poll cover the
  watch, so don't recheck every recent on a tree change.
- The record stores the document locator, not a second tree. Project slugs are
  read from the sources' trees at navigation time. A stored `local` address (a document
  known only by a device handle, from before a node's handle was its document id) is
  dropped when read.
