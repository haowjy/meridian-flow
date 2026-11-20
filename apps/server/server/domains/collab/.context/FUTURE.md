# collab FUTURE

These are deferred improvements, not current contracts. Preserve the live authority fences
while pursuing them.

## Restoring an earlier version

Writers will be able to restore an old version of a document from its
checkpoints. `checkpoints.ts` has `restore`, `listCheckpoints` and
`createCheckpoint` for this, with no production caller yet: don't delete them as
dead code. Older `document_yjs_checkpoints` rows are that feature's history, so
reducing them needs a retention rule, not a single checkpoint per generation.

The likely rule: always keep the initial checkpoint, the latest of each authority
generation and explicit ones; thin older automatic ones by age. Prune inside the
checkpoint transaction, under the document mutation lock, and never delete
`latest_checkpoint_id`. `restore` needs the same lock, or a prune can remove its
source between `getCheckpoint` and `replaceGeneration`. `seed_live_snapshot` can't
reuse a checkpoint yet: nothing resolves one by exact position with attribution.

## Edit bytes stay on parts

`document_edit_parts.update` duplicates a journal row on purpose. Live compaction
deletes those rows, and undo, revert and Apply need the bytes afterwards. Dropping
the column first needs a retention floor for every receipted origin, one resolver
for all its readers, and a failure path for a missing origin.

## Large-history recovery

Measure idle recovery query plans with settled history before adding a partial
state index for dirty-signal reconciliation or delivery. Keep each scan
bounded to actionable rows rather than settled history.

## Model-write and room-admission statements

Measure current statement counts for a model write and room admission before
narrowing confirmation or head/checkpoint reads. Optimize only after identifying
which persistence or lock boundary dominates.

## Admission fast-path deletion

`domain/provenance.ts` now indexes incoming structs for both admission walks
(#975). Measure ordinary typing with the memoized general walk alone; if it
is sufficient, delete `isPlainProseFastPath` and its duplicate root/anchor and
delete checks.

## Turn tree lines: a move out and back reads as a position change

`turn-live-lineage.ts` keeps a tree line whose `to` equals `from` so a rank-only
model move reads "Changed the position of X". A turn that moves a document to
another folder and back lands on the same path, so it reads the same way
although the model never reordered anything. Telling the two apart needs the
entry's rank or sibling neighbours in the turn's tree entries, not only paths.
