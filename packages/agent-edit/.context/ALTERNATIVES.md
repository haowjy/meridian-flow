# Alternatives considered — agent-edit

These rejected directions remain useful only to prevent reopening settled
boundaries. They are not deferred implementation work; active work belongs in
[TODO.md](TODO.md) or [FUTURE.md](FUTURE.md).

## Persisted offline overlay

Rejected: model the runtime as a durable clean base plus a persisted pending
operation overlay, so rollback drops the overlay and commit folds it into the
base.

The current contract intentionally makes canonical state authoritative and
runtime state disposable. A persisted overlay would add crash, versioning,
concurrent-edit, and partial-commit consistency surfaces around the same
journal that cold reconstruction already handles. It would also require a
second attribution path for staging and recovery.

Revisit only if measured cold reconstruction on real document sizes dominates
turn latency. Until then, keep one canonical rebuild path and the response
buffer in memory.
