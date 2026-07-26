# domains/notices

Durable, typed notice queue for model context. Producers record once for a
thread; the runtime destructively drains that thread before every model call.

Keep this domain transport-focused. It owns persistence and destructive
delivery, but not model prompt formatting.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
