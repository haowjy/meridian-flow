# domains/notices — durable model-context delivery

This domain owns typed, thread-scoped notices in the durable Postgres queue.
It records, peeks, and consumes notices; delivery into thread history and
producer-specific failure policy remain at the runtime or mutation boundary.

Read the [notice contract](.context/CONTEXT.md) before changing notice shape,
ordering, consumption, or failure handling. Notices inform a later model call;
they never become mutation authority or a read-required fence.

The queue is not conversation history until runtime delivery materializes the
selected rows into a durable system-update turn. Preparation failure and
cancellation leave notices pending; consume only the IDs committed with that
turn.

The contract lives in [.context/CONTEXT.md](.context/CONTEXT.md); callers own
whether a notice is best-effort or transaction-coupled.

Keep notice ordering and selected-ID consumption deterministic; do not turn a
notice into an implicit tool permission or Work-binding operation.
