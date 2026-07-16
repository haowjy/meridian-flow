# domains/notices

Durable, typed safety-notice queue shared by model-context and writer delivery.
Producers record once; the runtime drains relevant thread/document deliveries
before every model call, while collab transport drains writer-visible notices.

Keep this domain transport-focused. It owns persistence, delivery fan-out, and
the hash-body invariant, but not model prompt formatting or client rendering.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
