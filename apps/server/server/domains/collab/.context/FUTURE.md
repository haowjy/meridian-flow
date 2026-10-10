# collab FUTURE

## Recovery at large history sizes

- Measure idle recovery query cost with large settled history in
  `adapters/drizzle-change-trail-aggregate.ts`; actionable predicates avoid
  history-induced settlement delay but may still scan much of that history.
  Consider a partial state index after measuring the plan.
- Extend `adapters/drizzle-change-trail-aggregate.db.test.ts` history regression
  with old `turn_trail_work` rows as well as settled shells, explicitly protecting
  both candidate-page predicates from independent regressions.

## Reply save and room admission statement counts

Measured on PR 2 ([file-policy performance](../../file-policy/.context/performance.md)):
a reply save costs about 53 statements per written document (60, 268 and
1,048 for 1, 5 and 20 documents), almost none of it permissions. Room
Admission was measured at 14 statements per connection before the live manifest
was retired; remeasure the remaining non-permission work:
`document_yjs_heads.schema_version` read 4 times, and
the checkpoint plus journal loaded twice for the live generation. Trim
these when saves or reconnects show up as slow.

**Affected paths:** the reply save (`finalizeResponseCommit` in
`apps/server/server/lib/model-tools/response-write-lifecycle.ts`, then the
pool's save in `domain/thread-peer-core-pool.ts`), room admission
(`admitLiveSync` in `apps/server/server/lib/yjs-ws-handler.ts`), and the
journal and head adapters.
