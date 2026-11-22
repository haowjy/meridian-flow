# collab FUTURE

These are deferred improvements, not current contracts.

## Restoring an earlier version

Writers will be able to restore an old version of a document. A Live room keeps its history for
7 days past compaction (`historyMs`), so a restore within that window can check out the version
and write it onto the document as it stands, aligned so unchanged text keeps its block ids: open
tabs, offline copies and the AI merge into it like any edit. A version older than the cutoff needs
a stored snapshot of its own, which nothing keeps yet.

## Large-history recovery

Measure idle recovery query plans with settled history before adding a partial
state index for dirty-signal reconciliation or delivery. Keep each scan
bounded to actionable rows rather than settled history.

## Model-write and room-join statements

Measure current statement counts for a model write and a room Join before narrowing access
confirmation or snapshot reads. Optimize only after identifying which persistence or lock
boundary dominates.

## Turn tree lines: a move out and back reads as a position change

`turn-live-lineage.ts` keeps a tree line whose `to` equals `from` so a rank-only
model move reads "Changed the position of X". A turn that moves a document to
another folder and back lands on the same path, so it reads the same way
although the model never reordered anything. Telling the two apart needs the
entry's rank or sibling neighbours in the turn's tree entries, not only paths.
