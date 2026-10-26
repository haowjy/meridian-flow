# collab FUTURE

These are deferred improvements, not current contracts. Preserve the existing
draft row ordering and live authority fences while pursuing them.

## Intent-aware manifest command

Unify manifest reconciliation and mutation behind one intent-aware command in
`composition.ts` and `adapters/drizzle-drafts.ts`. The command must
distinguish a legacy raw row from a not-yet-recorded draft create without
using caller ordering as domain semantics. `domain/ports/work-branch-pending-store.ts`
remains the independent pending-review authority.

## Large-history recovery

Measure idle recovery query plans with settled history before adding a partial
state index for dirty-signal reconciliation or delivery. Keep each scan
bounded to actionable rows rather than settled history.

## Reply-save and room-admission statements

Measure current statement counts for reply save and room admission before
narrowing confirmation or head/checkpoint reads. Optimize only after identifying
which persistence or lock boundary dominates.

## Admission fast-path deletion

`domain/provenance.ts` now indexes incoming structs for both admission walks
(#975). Measure ordinary typing with the memoized general walk alone; if it
is sufficient, delete `isPlainProseFastPath` and its duplicate root/anchor and
delete checks. Preserve committed-prefix validation under the draft row hold.

## Turn tree lines: a move out and back reads as a position change

`turn-live-lineage.ts` keeps a tree line whose `to` equals `from` so a rank-only
model move reads "Changed the position of X". A turn that moves a document to
another folder and back lands on the same path, so it reads the same way
although the model never reordered anything. Telling the two apart needs the
entry's rank or sibling neighbours in the turn's tree entries, not only paths.
