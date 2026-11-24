# TODO

- `loro-ws-handler.ts` (`admit`): a document stored under a major this server does not serve is
  refused `document-schema-stale` with no automatic repair, which the
  [repair-first rule](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/index.md#document-schema)
  tolerates only while major bumps stay out of ordinary operation. If a major schema
  bump becomes real, build the migration path (load under compat, transform, restamp)
  and route this refusal into it.
