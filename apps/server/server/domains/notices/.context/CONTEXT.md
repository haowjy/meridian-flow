# notices — durable model-context delivery

Notices are typed, thread-scoped rows in the durable `pending_notices` queue.
A queue row is not conversation history until runtime materializes it into the
thread's durable turn history.

## Port and delivery contract

`NoticePort` records `NoticeInput`, peeks a thread's pending rows, and consumes
selected IDs during commit. Results are ordered by creation time and notice ID.
Runtime peeks at each model-call boundary and mid-run inbox adoption; commit
consumes exactly the selected IDs and appends one trailing `system` turn with
`{ kind: "system_update", section: "notices" }` metadata at that boundary.
Notice bytes must be identical on later requests so the frozen prompt prefix
remains stable.

Preparation failure or cancellation leaves rows pending. A Work-switch notice
is one-shot causal context and never replaces persistent hidden Work context;
the model cannot rebind a Work. Current notice kinds are `undo`,
`awareness_degraded`, and writer-origin `work_switched`.

## Failure boundary

Failure policy belongs to the producer. Collaboration notices are best-effort
after the underlying edit commits; the composition layer catches and logs
failures and may enqueue `awareness_degraded`. A writer Work rebind records
`work_switched` in the same transaction as the binding transition, so notice
failure rolls the transition back rather than committing a silent switch.

Notices never become mutation authority or a write fence. A writer
reverses a switch by selecting the previous Work normally; no switch-specific
Undo/Redo path exists.
