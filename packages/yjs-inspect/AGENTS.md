# @meridian/yjs-inspect

Liftable, browser-safe utilities for turning binary Hocuspocus/Yjs messages
into metadata-only summaries. The package has no Meridian or Hocuspocus
dependency; its outer-frame decoder directly reads the stable lib0 envelope.

## Content rule

Exports may return counts, clocks, client ids, node-type names, byte sizes,
hashes, and the Hocuspocus document address. They must never return document
text, attribute values, stateless payloads, or awareness state contents. Keep
the canary test exhaustive over every exported function.

`summarizeAwareness` returns per-client `{ client, clock, removed }` deltas.
This is the state-free resolution: a single awareness payload proves removals
(`null`) but cannot distinguish additions from updates without caller state.

## Journal decoder

Summarize hex rows from a file or stdin:

```sh
pnpm tsx packages/yjs-inspect/examples/decode-journal.ts updates.txt
cat updates.txt | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
```

The example header contains the exact `psql` pipeline for
`document_yjs_updates.update_data`.
