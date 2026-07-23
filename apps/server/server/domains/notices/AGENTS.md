# domains/notices

Durable, typed notice queue for model context. Producers record once; the
runtime drains relevant thread/document deliveries before every model call.

Keep this domain transport-focused. It owns persistence, delivery fan-out, and
the hash-body invariant, but not model prompt formatting.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
