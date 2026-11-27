# TODO

- `loro-ws-handler.ts` (`admit`): a document stored under a major this server does not serve is
  refused `document-schema-stale` with no automatic repair, which the
  [repair-first rule](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/index.md#document-schema)
  tolerates only while major bumps stay out of ordinary operation. If a major schema
  bump becomes real, build the migration path (load under compat, transform, restamp)
  and route this refusal into it.
- `loro-presence.ts`: the presence timeout (30 s) is defined here and again in the app's
  `core/editor/local-presence.ts`; the two must agree, since each side expires the other's
  entries. Export one constant from `@meridian/contracts/protocol` once #1889, which rewrites
  this file, has landed.
