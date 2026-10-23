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

Do not cache `.nx` outputs across Actions runs. The pnpm dependency cache is
independent. Local target caches include the shared configuration inputs below.

## Staged typechecking

`pnpm typecheck:staged` selects work from the Git index. `pnpm typecheck`,
`pnpm check` and CI still select every project with a typecheck target.

```text
Git index paths → documentation filter → Nx affected projects and consumers
                                         → configured typecheck targets
```

The runner skips `.md`, `.mdc`, `.markdown`, `.txt` and `.rst` paths before
starting Nx. It does not skip executable MDX. Git's NUL-delimited output and
disabled rename detection preserve deleted paths and both rename endpoints.
Nx receives paths on stdin, not a shell-expanded or comma-separated argument.
A filename containing a newline selects all projects because Nx's stdin
protocol cannot represent it.

Nx owns dependency traversal and filters the result to projects exposing the
requested target. Each target retains its tsconfig, cache and normal failure
handling. `NX_EXCLUDE_PROJECTS` remains an explicit comma-separated override for
both full and staged commands; normal hooks and CI do not set it.

Selection is not snapshot validation: the index supplies paths, but Nx's graph
and target commands read the working tree. Unstaged errors in selected projects
can fail a commit. No files are hidden or stashed.

`nx.json`'s `sharedConfiguration` input governs both broad selection and cache
invalidation: root configuration files, package-manager settings, shared package
tsconfigs, dependency patches and the target runner. Add future shared compiler
or dependency inputs there, not to a second list in the hook. Project-local
configuration follows the project's normal dependency graph.

### Staged hook probe recipe

Use an owned worktree with dependencies installed and an empty index. Save or
restore only your own probe edits. Run `pnpm exec lefthook run pre-commit` for the
whole hook, or `pnpm typecheck:staged` to isolate typechecking.

1. Stage an edit to root `AGENTS.md` and a package README. Expect a skip with no
   Nx or TypeScript task. Repeat with an empty index and with unstaged source
   errors: selection must still skip. Unstage and restore the documentation.
2. Stage a source change in `packages/contracts/src/`. Expect contracts and
   its Nx consumers, including app and server, but not unrelated projects.
   Compare with:

   ```sh
   printf 'packages/contracts/src/index.ts\n' | pnpm nx show projects --affected --stdin --withTarget=typecheck --json
   ```
3. Introduce `export const probe: number = "wrong";` in a selected source file.
   Expect a real TypeScript diagnostic and nonzero hook exit. Fix it and rerun;
   expect success. Leave the error unstaged with another change in that same
   project staged: expect failure because checks read the working tree.
4. Stage a root tsconfig, `pnpm-workspace.yaml`, dependency patch or
   `packages/tsconfig.package-base.json` change. Each must select all current
   typecheck projects. Run twice to populate/reuse the cache, then change a
   shared compiler option to an invalid value: cached successes must not hide
   the compiler error. Restore it and confirm success.
5. Stage a source deletion and then a cross-project rename. Both source and
   destination projects and their consumers must participate. Repeat with
   spaces and commas in filenames. Rename source to `.md`: the deleted source
   endpoint must still trigger checks. Rename documentation within documentation:
   expect a skip. Restore each probe before the next.
6. Run `pnpm typecheck` with only documentation staged. Expect every project;
   staged selection must not leak into full gates.

## PR body and changelog

`check-pr-body.mjs` requires every template section and validates the structured
`## Changelog` section through `pr-changelog.mjs`. `pnpm changelog` runs
`build-changelog.mjs`, which uses that same parser to build Markdown or JSON from
PRs merged into `main`. GitHub results arrive in 50-PR pages; ranged builds stop
once the pages pass their cutoff, while `--all` follows every page. Pass `--input
<file>` to build from saved `gh` JSON. A
malformed section fails the whole build and names its PR rather than silently
omitting an entry, so consumers must check the exit status. Interactive Markdown
uses `$PAGER` or `less -FRX`; pipes, redirects, JSON, and `--no-pager` print directly.

## Test budget ratchet

There is no target case count. `tools/ci/test-budget-reporter.ts` runs inside
every unit and DB run and compares the **expanded case count per test file**
(every `it`, every `it.each` / `describe.each` row) against
`tools/ci/test-case-baseline.json`.

- A file that has grown, or a test file that is missing from the baseline, fails
  the run. Growth is allowed but must be declared: refresh with
  `TEST_BUDGET_UPDATE=1 pnpm test` (or `pnpm test:all` for both suites) so the
  change is a reviewable line instead of silent drift.
- Comparison is per file rather than per run because CI shards the unit suite
  across two jobs and neither job sees the whole suite. Counts come from
  collection (`allTests()`), so skipped cases and `it.each` rows count.
- The same reporter prints the run wall time and warns when it exceeds
  `TEST_DURATION_REFERENCE_SECONDS`: 150 for the unit suite, 600 for the DB
  suite, which runs serially in CI and so pays the sum of every test rather than
  a fraction of it. The warning never fails the run. Wall time tracks the machine
  and the worker count, not only the suite, so identical work has measured 45 s to
  104 s on the unit side and 89 s to 322 s on the DB side. Read it as a signal to
  check what changed, not as a gate.
- It also samples RSS across the whole process tree (descendants included, so a
  `forks` pool's children count) and enforces `TEST_MEMORY_CEILING_MB` (default
  4096) **on every run except a refresh**: a `TEST_BUDGET_UPDATE=1` run writes
  the baseline and returns before both the growth and memory checks. Memory
  blocks everywhere else because it is a property of the suite, not of the
  machine's load. Known peaks: unit 3.0 GB at 8 workers,
  DB 3.5 GB at 4 fork workers; the DB suite reaches 6.0 GB at 8 workers, so an
  eight-worker local DB run will trip the ceiling — that is the intended signal.
- The DB suite is not sharded, but it uses the same baseline file so one number
  covers both suites. A unit-only or DB-only refresh merges rather than replaces,
  and drops entries whose file no longer exists.
- When two branches conflict on the baseline, merge it per file key, three-way
  against the merge base (take whichever side changed a key; if both changed
  it, the refresh decides). Then refresh on the merged tree
  (`TEST_BUDGET_UPDATE=1 pnpm test:all`) and check that the refresh diff
  touches only test files the incoming branch changed; any other line is growth
  no one declared. A plain run, or CI, then enforces the memory ceiling.

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
excluded because it defines the column.

Every entry is permanent and its reason is the audit's reason: no entry may be
temporary (`rg -c '"pending:' tools/ci/tree-visibility-allowlist.json` finds
none). Stale detection operates per entry, not per form; keep forms as narrow as
the permitted operations.

To add a fixture, create a `.ts` file in
`tools/ci/fixtures/tree-visibility/`. Mark each offending source line with
`// expect: <rule>` (`from`, `query`, `write`, `raw-read`, `raw-write`, `escape`,
`hidden`). More than one rule on a line uses repeated markers. For a multiline
SQL template, put the marker in a TypeScript comment on the tag's line, not in
the SQL text. Unmarked findings and missed markers both fail the self-test.
No-findings examples belong in `allowed.ts`; they protect against false
positives. Fixtures need not execute or typecheck; the guard parses them as
source. Run the check and lint after changing fixtures.
