# notices — durable model-context delivery

Notices are durable queue records injected into model context. They communicate
runtime outcomes without becoming conversation turns or changing the thread's
logical head.

## Port contract

`NoticePort` records a typed, thread-scoped `NoticeInput` and destructively
drains model delivery for that thread.

Results are ordered by creation time and notice ID. The orchestrator drains immediately before every
`gateway.stream()` call and injects a transient system message after context
assembly. No notice is stored as a turn or block, rendered by `buildContext`, or
allowed to own `activeLeafTurnId`.

The domain contains only notices that affect a later model call: `undo` and
`awareness_degraded`. Writer-facing change reporting belongs to Trail/Restore,
not this queue.

## Failure boundary

Once the underlying mutation is durable, notice failure cannot make the write
look rolled back. The collab composition layer catches and structured-logs the
failure, sets the READ-REQUIRED fence, and attempts an `awareness_degraded`
notice. If that fallback record also fails, the fence remains and the second
failure is logged; durable state is still reported as durable.
