# test-support — depth

Rules to know first: [AGENTS.md](../AGENTS.md).

## Detached work

The server DB setup drains detached work after each case, once file-local
teardown finishes and before suite pool closers run. A file-level drain remains
the backstop before the next file uses that worker. A file `afterAll` that starts
detached DB work must use `closeTestDatabase`.

The reset helper cannot drain an isolated tracker, so harnesses share
`processDetachedWork`. Room unload schedules checkpoint stores without awaiting
them, so checkpoints join the same tracker. Collab producers stop and join their
own work through `collab.lifecycle.dispose`, which a harness awaits before
resetting rows, so running work cannot deadlock against the reset's locks. See
[collab's CONTEXT.md](../../domains/collab/.context/CONTEXT.md).

## Branch-tree suites

One world per case. `branch-tree-seeds.ts` writes rows the way the product leaves
them; `branch-tree-commands.ts` drives the composed runtime and has no Apply verb.
Assert through these verbs (what the writer or a reader sees), not raw tables, and
seed only states the product can't reach yet. Lock races go through
`lock-interleave.ts`: `race` names each run, so an order table reads the same
outcome whichever ran first, and `waitForPostgresLock` gives bespoke lock
observations one deadline.
