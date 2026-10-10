# CI checks

[CI](../../.github/workflows/ci.yml) runs four parallel quality jobs:

- `quality-static`: lint, debug probes, negative space, tree visibility, i18n and the Nx graph.
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

## Tree visibility boundary

`pnpm check:tree-visibility` parses server code, server scripts, package `src/`
code and tools with the TypeScript compiler API (no program or type checker).
It rejects reads and writes of `documents` and `folders` outside the explicit
query boundary. Schema definitions, migrations, tests and test support are
excluded. Fixtures are checked separately, first, on **every invocation**.

The syntactic rules cover Drizzle `from`/joins, relational `query`,
`insert`/`update`/`delete`, imported `sql` templates and `sql.raw` strings, and
bare table bindings escaping into helpers. Renamed imports, namespace imports,
`alias()` results and local shadowing are tracked per file. Raw SQL recognizes
bare, quoted and schema-qualified table names without matching longer names
such as `documents_archive` or `documents_view`. `getTableColumns`
and `getTableName` are metadata operations, not escapes. Column references and
type positions do not count as queries. This is a syntactic guard, not a
whole-program dataflow analysis: wrappers must accept tree views, not raw tables.

`tools/ci/tree-visibility-allowlist.json` lists file paths or `*`/`**` globs,
`forms` (`read`, `write`) and nonempty reasons. An uncovered finding, a stale
entry (covers no finding) or a duplicate path fails the check. A `hidden`
reference, mutation key or SQL mention associated with either table is never
allowlistable outside `apps/server/server/domains/context/tree/`. The schema is
excluded because it defines the column. The tree-owner glob is added only when
that module exists and contains findings.

Temporary entries use reasons starting `pending: lane <X>` from the foundation
reader audit. Each converting lane removes its pending entry; lane V's final
gate is `rg -c '"pending:' tools/ci/tree-visibility-allowlist.json` = 0 (no
matches; ripgrep exits 1). Two permanent entries currently have transitional
forms: `context-fs/drizzle-store.ts` allows reads until lane C converts them
(then `forms` becomes `["write"]`), and `drizzle-branches.ts` allows the manifest
write until lane M deletes it (then `forms` becomes `["read"]`). Their reasons
are the final audit reasons. Stale detection operates per entry, not per form;
lane V must also tighten these two forms.

To add a fixture, create a `.ts` file in
`tools/ci/fixtures/tree-visibility/`. Mark each offending source line with
`// expect: <rule>` (`from`, `query`, `write`, `raw-read`, `raw-write`, `escape`,
`hidden`). More than one rule on a line uses repeated markers. For a multiline
SQL template, put the marker in a TypeScript comment on the tag's line, not in
the SQL text. Unmarked findings and missed markers both fail the self-test.
No-findings examples belong in `allowed.ts`; they protect against false
positives. Fixtures need not execute or typecheck; the guard parses them as
source. Run the check and lint after changing fixtures.
