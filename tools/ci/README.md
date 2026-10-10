# CI checks

[CI](../../.github/workflows/ci.yml) runs four parallel quality jobs:

- `quality-static`: lint, debug probes, negative space, i18n and the Nx graph.
- `quality-typecheck`: typecheck, with runner-local Nx caching only.
- `quality-test-1` and `quality-test-2`: the default unit test projects, using
  Vitest `--shard=1/2` and `--shard=2/2` on the same `test` script.

Lint and the small checks share a runner because together they take seconds,
not minutes. The `quality` required status depends on all four jobs, runs
under `always()`, and fails unless every dependency succeeded. The jobs are explicit rather
than matrix children so the aggregate checks each result directly, including
after partial reruns. A failing group does not cancel the others. All jobs, including
the aggregate, skip draft PRs.

`package.json`'s `scripts.check` remains the local full gate and the source of
truth. `run-check-group.mjs` reads its `pnpm <script> && ...` chain and invokes
those same named scripts. The test group forwards trailing arguments to that
script; static and typecheck reject them. New steps automatically join `quality-static`.
Unsupported chain syntax or a missing isolated/DB step fails explicitly.
`check:db` stays local; CI's separate `db-tests` job provisions Postgres and
forces the DB suite. Migration checks and the two app boot jobs are unchanged.

Do not cache `.nx` outputs across Actions runs: Nx inputs are project-scoped
and can miss root config changes. The pnpm dependency cache is independent.

## Runtime verification

Run from an owned checkout with dependencies installed:

```sh
node tools/ci/run-check-group.mjs static
node tools/ci/run-check-group.mjs typecheck
node tools/ci/run-check-group.mjs test --shard=1/2
node tools/ci/run-check-group.mjs test --shard=2/2
pnpm check
```

For coverage-drift proof, temporarily add a named script that prints a marker
and append `&& pnpm <name>` to `scripts.check`. Run the static group and observe
the marker. Make that script exit nonzero and confirm the runner propagates
failure. Change the appended command to unsupported shell syntax and confirm
the partition refuses it. Restore `package.json` after each probe.

For the required-status contract, push a temporary failing unit test on a non-draft
PR. Wait for CI and inspect `gh run view <run-id> --json jobs`: the failing shard
and `quality` must both report `failure`, not `skipped`. Revert the temporary
commit, push, and require all jobs green before marking ready. Record both run
URLs and each job's start/end timestamps. This real Actions probe covers the
dependency aggregation and `always()` behavior a local shell test cannot prove.

For shard coverage, run the unsharded test group and both shard commands with
`--reporter=json --outputFile=<unique-file>.json`. Compare the `name` values in
`testResults`: the shard sets must be disjoint and their union must equal the
unsharded set. Compare summed test counts too. Keep evidence outside the checkout.
Vitest partitions by file count, not measured duration; record each Actions
job's duration before considering a custom balancer.
