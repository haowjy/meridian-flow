# collab FUTURE

## Recovery at large history sizes

- Measure idle recovery query cost with large settled history in
  `adapters/drizzle-change-trail-aggregate.ts`; actionable predicates avoid
  history-induced settlement delay but may still scan much of that history.
  Consider a partial state index after measuring the plan.

## Reply save and room admission statement counts

Measured on PR 2 ([file-policy performance](../../file-policy/.context/performance.md)),
before the project manifest read left the path, so re-measure first:
a reply save costs about 53 statements per written document (60, 268 and
1,048 for 1, 5 and 20 documents), almost none of it permissions. Room
admission costs 14 statements per connection; most aren't permissions:
`document_yjs_heads.schema_version` read 4 times, and
the checkpoint plus journal loaded twice for the live generation. Trim
these when saves or reconnects show up as slow.

**Affected paths:** the reply save (`finalizeResponseCommit` in
`apps/server/server/lib/model-tools/response-write-lifecycle.ts`, then the
pool's save in `domain/thread-peer-core-pool.ts`), room admission
(`admitLiveSync` in `apps/server/server/lib/yjs-ws-handler.ts`), and the
journal and head adapters.
