# Account recents

- A removal is a document id until a local open of that id. A list can't clear or
  import it. The oldest removal this record actually held may fall off the cap,
  which isn't a list-driven clear. `applyAvailability` remembers only ids dropped
  from this record in that call, so unrelated removals don't consume removal capacity.
- A reversible create Undo stores the removed recent with its tombstone. Redo
  restores the row at its original `openedAt`, updating only the document's
  current name and address, so reversal doesn't make an old document recent.
- A removal the project's list shows (Trash, purge) drops the row; a later locator renames it. A presented document
  does the same for a row still in the record, including a local draft's name.
- A local handle isn't watched; a document locator is, by the removal observer
  (`list-removal-observer.ts`), which reads the project's list when it changes: a recent
  whose node is in Trash or purged is dropped, and nothing is polled.
- The record stores the document locator, not a second tree. Project slugs are
  read from the sources' trees at navigation time.
