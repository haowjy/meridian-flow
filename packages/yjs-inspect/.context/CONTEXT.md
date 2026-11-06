# packages/yjs-inspect — context

## Contracts

**Egress, not decoding.** The content rule guards what leaves the package. Yjs decodes item
content during `Y.decodeUpdate`, the same path every product-side `applyUpdate` runs, and
`Y.parseUpdateMeta` and `Y.decodeUpdate` both instantiate `ContentString` in-process, so the
transient decode adds no exposure. The canary also rejects non-JSON-natural output shapes
(Uint8Array, Map, Set, Symbol, foreign prototypes), because lib0 and yjs containers leak
content through them.

**Total observer boundary.** `summarizeUpdate` never throws because server journal admission
receipts call it on the product path, where a throwing observer turns instrumentation into a
product exception. `InvalidUpdate` keeps the offending row identifiable and must never pass as
the no-op correlation class.

**Delete spans key on the creator of the deleted items.** That is the only identity the
protocol carries: delete sets record `(client, clock, length)` with `client` the original
author, and the deleter exists only as the transaction origin, outside the delete-set encoding.

**Stateless bodies are read as bytes** (`readVarUint8Array`), not strings, so observer code
never materializes the content. Close reasons are counted as bytes the same way.

## Rationale

**`updateHash` is a secondary key.** It is exact-byte correlation and breaks when the server
merges, re-encodes or compacts updates. Spans survive `Y.mergeUpdates` and are the primary
correlation identity. Yjs accepts trailing bytes after a valid update: spans ignore them, but
`bytes` and `updateHash` cover the full input.

**Per-transaction vs cumulative delete sets.** `doc.on("update")`, the wire path Hocuspocus
forwards, carries a transaction's own delete spans. `Y.encodeStateAsUpdate(doc, sv)`
(sync-step-2) carries the cumulative delete set, fanning in to many client entries. Consumers
must distinguish these paths when correlating.

## Patterns

`examples/decode-journal.ts` summarizes hex rows from a file or stdin; its header has the
`psql` pipeline for `document_yjs_updates.update_data`.
