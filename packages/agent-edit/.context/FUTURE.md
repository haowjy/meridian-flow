# agent-edit FUTURE

## Model guidance for mangled merges

The `concurrent edits by <author>:` listing names who changed the document but
not how the merge turned out. Consider letting the model repair a visibly mangled
merge if real transcripts show it needs guidance and prompt validation confirms
the copy does not invite unwanted rewriting. The seam is echo and response
formatting.

## Complete-plan apply preflight

A write that a later group or provenance materializer rejects leaves nothing
behind: it ran on that call's disposable view and room copy. A stronger all-plan
preflight or clone-then-merge path waits for an adapter with a concrete
failure-prone operation the current preflight cannot protect.

## One projection per write plan

A write projects its planning document in `planWrite` and again when it snapshots
the before-state (`snapshotBlocks(planDoc)`), with nothing changing the document in
between. Sharing one projection needs `projected` on `WritePlan` and
`PreparedEdit.plan`, plus a path for the `{ blocks }` create, which has no plan
projection. Take it when profiling shows edit latency matters.
