# Test reliability

- `drizzle-tree-mutation-store.db.test.ts`, “deletes empty and populated folders
  with exact content identities”: compare the document IDs in the returned
  `removed` entries as identities, unless an explicit ordering contract is added. The G2 DB run saw
  the same four correct ids in a different order, with the manuscript id last;
  two subsequent full DB runs passed. Do not make PostgreSQL scan order part of
  this deletion contract. Found by work `diff-based-review`, lane G2.
