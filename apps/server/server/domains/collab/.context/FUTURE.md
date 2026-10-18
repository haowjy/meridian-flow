# collab FUTURE

These are deferred improvements, not current contracts. Preserve the existing
pending-review authority and settlement fences while pursuing them.

## Intent-aware manifest command

Unify manifest reconciliation and mutation behind one intent-aware command in
`composition.ts` and `adapters/drizzle-drafts.ts`. The command must
distinguish a legacy raw row from a not-yet-recorded draft create without
using caller ordering as domain semantics. `domain/ports/work-branch-pending-store.ts`
remains the independent pending-review authority.

## Large-history recovery

Measure idle recovery query plans with settled history before adding a partial
state index. Keep actionable predicates from turning settlement delay into a
full history scan.

## Reply-save and room-admission statements

Measure current statement counts for reply save and room admission before
narrowing confirmation or head/checkpoint reads. Optimize only after identifying
which persistence or lock boundary dominates.
