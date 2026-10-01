# notices — durable model-context delivery

Notices are a durable Postgres queue (`pending_notices`) that `NoticePort`
peeks into model context. A queue row itself is never conversation history,
but delivery into a thread's history is durable turn history, not a
request-only splice — see below.

## Port contract

`NoticePort` records typed, thread-scoped `NoticeInput`, peeks pending notices
for a thread, and consumes selected rows by ID during commit.

Results are ordered by creation time and notice ID. Runtime delivery peeks a
thread's notices at each boundary before a `gateway.stream()` call and at each
mid-run inbox adoption. The commit consumes exactly the selected notice IDs
and folds them into the same durable-turn materialization as an inbox batch
(`drainInbox`/`noticesTurnFor`, `runtime/loop/inbox-context.ts`): one trailing
`system`-role turn with `{ kind: "system_update", section: "notices" }`
metadata, positioned at that boundary (after the writer message pre-turn or
the preceding tool result mid-run). Preparation failure or cancellation leaves
the rows pending. The durable turn keeps notice bytes identical on every later
request, which the frozen prefix's Anthropic cache breakpoints require (thread
AGENTS.md / runtime CONTEXT.md).

The domain contains only notices that affect a later model call: `undo`,
`awareness_degraded`, and writer-origin `work_switched`. A Work-switch notice is
one-shot causal context; it does not replace the persistent hidden Work-context
update. Model-origin Work switches do not enqueue the notice because their tool
call and result already carry the event.

## Failure boundary

Failure policy belongs to the producer's mutation boundary. Collaboration
notices remain best-effort after the underlying edit is durable: their
composition layer catches and structured-logs failures and may attempt an
`awareness_degraded` fallback. Writer Work rebinds instead record
`work_switched` in the same ambient transaction as the binding transition, so a
Notice failure rolls the transition back rather than committing a silent
switch. A writer reverses a switch by selecting the previous Work normally;
there is no switch-specific Undo/Redo path. Notices never become mutation
authority or a read-required fence.
