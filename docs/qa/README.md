# Runtime probes

Use these recipes to check the running product, in addition to `pnpm check`.
Keep evidence in the active work directory, not in this repository. Record the
commit, date, stack/provider, outcome, and evidence path after each run. A recipe
is not a claim that it passed on the current commit.

- [Runtime protocols](runtime-probes.md): RP-1 through RP-11, driven with `./mf`.
- [Draft review](draft-review.md): visual editor and review workflows.
- [Debugging](../debugging.md): CLI reference, logs, and model-request inspection.

Run on an owned worktree and database. Discover HTTPS routes with
`pnpm portless:list`; never target another worktree's process or clear its mock
queue. Stop only your stack with `pnpm dev --stop` when finished.
