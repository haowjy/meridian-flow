# agent-edit FUTURE

## Complete-plan apply preflight

A write that a later step rejects leaves nothing
behind: it ran on that call's disposable view and room copy. A stronger all-plan
preflight or clone-then-merge path waits for an adapter with a concrete
failure-prone operation the current preflight cannot protect.

## One projection per write plan

A write projects its planning document in `planWrite` and again when it snapshots
the before-state (`snapshotProjected(model.projectBlocks(planDoc))`), with nothing changing the document in
between. Sharing one projection needs `projected` on `WritePlan` (`resolver/resolve.ts`)
and a way to hand it to the write's before-state snapshot, plus a path for the
`{ blocks }` create, which has no plan
projection. Take it when profiling shows edit latency matters.
