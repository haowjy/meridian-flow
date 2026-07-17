# @meridian/yjs-inspect

Liftable, browser-safe utilities for turning binary Hocuspocus/Yjs messages
into metadata-only summaries. The package has no Meridian or Hocuspocus
dependency; its outer-frame decoder directly reads the stable lib0 envelope.

## Public API

- `inspectFrame` is the tap-facing entry point. It classifies a complete wire
  frame and nests update or awareness metadata when the payload is decodable.
- `classifyFrame` performs envelope-only classification.
- `summarizeUpdate` handles bare updates held outside a wire frame.

Awareness summarization is internal to `inspectFrame`; only its metadata type
is public. Unknown, truncated, or malformed input must not crash frame
observers.

## Content egress invariant

No export may return, emit, store, log, or export manuscript text, attribute
or embedded values, stateless payloads, or awareness state contents. Outputs
are limited to counts, clocks, client ids, spans, byte sizes, hashes, and
type/class names. Transient materialization inside Yjs decode internals is
permitted. Keep the canary test exhaustive over every exported function and
every frame path.

## Update spans

Spans use an inclusive `clockFrom` and exclusive `clockTo`. Struct spans name
created clocks; delete spans name the creator of the deleted items, not the
deleter. `spansKey` always serializes numerically sorted struct tokens before
numerically sorted delete tokens.

Yjs accepts trailing bytes after a valid update. Spans ignore those bytes, but
`bytes` and `updateHash` cover the full input. Preserve this distinction:
`updateHash` is only a secondary exact-byte correlation key.

## Journal decoder

Summarize hex rows from a file or stdin:

```sh
pnpm tsx packages/yjs-inspect/examples/decode-journal.ts updates.txt
cat updates.txt | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
```

The example header contains the exact `psql` pipeline for
`document_yjs_updates.update_data`.
