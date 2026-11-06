# @meridian/yjs-inspect

Liftable, browser-safe utilities that turn binary Hocuspocus/Yjs messages into
metadata-only summaries. The production package depends only on `yjs` and `lib0`.

- No export may return, emit, store, log or export manuscript text, attribute or
  embedded values, stateless payloads or awareness state contents. Outputs are limited
  to counts, clocks, client ids, spans, byte sizes, hashes and type or class names.
  Keep the canary test exhaustive over every exported function and every frame path:
  it is the only check of the root rule that writer text stays out of diagnostics.
- Observers never throw: unknown, truncated or malformed input is classified, and
  `summarizeUpdate` returns `InvalidUpdate` metadata that cannot be mistaken for a
  valid no-op.

Rationale: [`.context/CONTEXT.md`](.context/CONTEXT.md).
