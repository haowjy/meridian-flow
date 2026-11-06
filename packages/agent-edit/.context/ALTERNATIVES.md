# Alternatives considered — agent-edit

## Persisted offline overlay

Rejected: a durable clean base plus a persisted pending-operation overlay, where
rollback drops the overlay and commit folds it into the base. It would add crash,
versioning, concurrent-edit and partial-commit consistency surfaces around the
journal that cold reconstruction already handles, and a second attribution path
for staging and recovery.

Revisit if measured cold reconstruction on real document sizes dominates turn
latency.
