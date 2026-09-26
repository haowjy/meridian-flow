# collab FUTURE

## Manifest lifecycle ownership consolidation

Manifest lifecycle is currently split across `composition.ts` (facade calls)
and `adapters/drizzle-branches.ts` (reconciliation + mutation). Caller ordering
can alter domain semantics: exposing `reconcile` and `record` as independently
sequenced facade calls lets incidental ordering promote a not-yet-recorded
draft create as a legacy raw row.

Use one intent-aware manifest command that owns reconciliation and mutation
ordering, so the additive healer
distinguishes a legacy raw row from a not-yet-recorded draft create at the
command boundary rather than through incidental timing.

**Affected paths:** `composition.ts`, `adapters/drizzle-branches.ts`. Preserve
`domain/work-draft-pending.ts` as the independent pending-review authority;
lifecycle consolidation must not make active branch status a proxy for
reviewable content.

## Recovery at large history sizes

- Measure idle recovery query cost with large settled history in
  `adapters/drizzle-change-trail-aggregate.ts`; actionable predicates avoid
  history-induced settlement delay but may still scan much of that history.
  Consider a partial state index after measuring the plan.
- Extend `adapters/drizzle-change-trail-aggregate.db.test.ts` history regression
  with old `turn_trail_work` rows as well as settled shells, explicitly protecting
  both candidate-page predicates from independent regressions.
