# agent-edit FUTURE

These are deferred directions, not current behavior. Keep the shipped
report-only merge semantics and preflight boundaries while evaluating them.

## Model guidance for mangled merges

The `concurrent edits by <author>:` listing names who changed the document
but says nothing about how the merge turned out. Consider letting the model repair a visibly mangled merge only if real transcripts show
that it needs guidance and prompt validation confirms the copy does not invite
unwanted rewriting. The owner seam is echo/response formatting.

## Complete-plan apply preflight

A write that a later group or provenance materializer rejects leaves nothing
behind: it ran on that call's disposable view and room copy. A stronger all-plan preflight or clone-then-
merge path is deferred until an adapter has a concrete failure-prone operation
that the current preflight cannot protect. Do not add a parallel transaction
planner without that producer.

## One projection per write plan

A write projects its planning document in `planWrite` and again when it snapshots
the before-state (`snapshotBlocks(planDoc)`), with nothing changing the document in
between. Sharing one projection needs `projected` on `WritePlan` and
`PreparedEdit.plan`, plus a path for the `{ blocks }` create, which has no plan
projection. Take it when profiling shows edit latency matters; reads, echoes and
observations already share their projections.
