# TODO

- `yjs-ws-handler.ts` (`classifyYjsConnectionAdmission`, `refuseSchemaAdmission` and
  the `onLoadDocument` backstop): `4407` has no automatic repair, which the
  [repair-first rule](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/index.md#document-schema)
  tolerates only while major bumps stay out of ordinary operation. If a major schema
  bump becomes real, build the migration path (load under compat, transform, restamp)
  and route this refusal into it.

- `model-tools/document-tools.ts`, `inContainer` around `resolveDocumentAddress`:
  profile before changing. On a 500-document seed the span measured 112–176 ms for a
  first draft write and 117–159 ms for later writes. It is aggregate: grant checks
  plus, for `create` and `copy`, `ContextFS.ensureTrackedDocument`, which calls
  `documentSync.ensureDocumentAuthority` even for an existing visible document. These
  numbers predate the explicit ensure, so re-measure first, and split authorization
  from ensure before claiming a fix. Likely direction: an existing staged overwrite
  skips the unnecessary repair read, with grants still confirmed in the right
  transaction.
