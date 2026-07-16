# notices — durable safety-outcome delivery

Safety notices are durable queue records with independent model and writer
delivery state. They communicate safety outcomes without becoming conversation
turns or changing the thread's logical head.

## Port contract

`NoticePort` records a typed `NoticeInput`, destructively drains model delivery
for a thread plus its active documents, destructively drains writer delivery for
a document, and publishes writer-visible events to live transport subscribers.
Model and writer consumption are independent: delivering to one audience does
not consume the other's pending row.

Document-scoped model notices create per-thread delivery rows when a thread
drains with that document active. Results are ordered by creation time and
notice ID. The orchestrator drains immediately before every
`gateway.stream()` call and injects a transient system message after context
assembly. No notice is stored as a turn or block, rendered by `buildContext`, or
allowed to own `activeLeafTurnId`.

Writer consumption cannot close a document-scoped notice while an active
thread still lacks a model-delivery row. The retention check uses the threads
domain's canonical active-document resolver, so explicit attachments and tool
touches have identical fan-out semantics. Document notices without a writer
channel remain retained for threads that attach after earlier model drains;
expiry, if introduced, is a separate policy.

Writer-visible notices are broadcast as stateless `safety_notice` WebSocket
messages. The transport drains writer delivery only after broadcasting to an
active Hocuspocus document. With no connected document, the durable row remains
pending for later delivery.

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
