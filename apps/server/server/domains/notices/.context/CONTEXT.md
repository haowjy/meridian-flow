# notices — durable model-context delivery

Notices are durable queue records injected into model context. They communicate
runtime outcomes without becoming conversation turns or changing the thread's
logical head.

## Port contract

`NoticePort` records a typed `NoticeInput` and destructively drains model
delivery for a thread plus its active documents.

Document-scoped model notices create per-thread delivery rows when a thread
drains with that document active. Results are ordered by creation time and
notice ID. The orchestrator drains immediately before every
`gateway.stream()` call and injects a transient system message after context
assembly. No notice is stored as a turn or block, rendered by `buildContext`, or
allowed to own `activeLeafTurnId`.

The retention check uses the threads domain's canonical active-document
resolver, so explicit attachments and tool touches have identical fan-out
semantics. Document notices remain retained for threads that attach after
earlier model drains; expiry, if introduced, is a separate policy.

## Hash/body invariant

`late_sweep` and `checkpoint_sweep` records must carry both
`affectedBlockHashes` and `capturedDeletedBodies`, with a body entry for every
affected hash. Producers use the explicit `body_unavailable` sentinel when no
snapshot source can reconstruct a body. The adapter rejects an incomplete
record rather than emit an unverifiable hash-only notice.

## Failure boundary

Once the underlying mutation is durable, notice failure cannot make the write
look rolled back. The collab composition layer catches and structured-logs the
failure, sets the READ-REQUIRED fence, and attempts an `awareness_degraded`
notice. If that fallback record also fails, the fence remains and the second
failure is logged; durable state is still reported as durable.
