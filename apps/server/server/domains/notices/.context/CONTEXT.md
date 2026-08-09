# notices — durable model-context delivery

Notices are durable queue records injected into model context. They communicate
runtime outcomes without becoming conversation turns or changing the thread's
logical head.

## Port contract

`NoticePort` records a typed, thread-scoped `NoticeInput` and destructively
drains model delivery for that thread.

Results are ordered by creation time and notice ID. The orchestrator drains
immediately before every `gateway.stream()` call. Pre-turn notices remain on the
current writer message for the entire tool loop; notices created during the loop
remain after the causal tool exchange. No notice is stored as a turn or block,
rendered by `buildContext`, or allowed to own `activeLeafTurnId`.

The domain contains only notices that affect a later model call: `undo`,
`awareness_degraded`, and writer-origin `work_switched`. A Work-switch notice is
one-shot causal context; it does not replace the persistent hidden Work-context
update. Model-origin Work switches do not enqueue the notice because their tool
call and result already carry the event.

## Failure boundary

Failure policy belongs to the producer's mutation boundary. Collaboration
notices remain best-effort after the underlying edit is durable: their
composition layer catches and structured-logs failures and may attempt an
`awareness_degraded` fallback. Writer Work rebinds and successful writer
Work-switch Undo/Redo instead record `work_switched` in the same ambient
transaction as the binding transition, so a Notice failure rolls the transition
back rather than committing a silent switch. Notices never become mutation
authority or a read-required fence.
