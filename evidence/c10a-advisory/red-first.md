# Red-first DB contract

Command: `pnpm test:db -- apps/server/server/domains/runtime/loop/compaction-undo.db.test.ts`

The pre-fix implementation produced 23 passing tests and 3 expected failures in the new advisory contracts (26 tests total):

- `C6b snapshot advisory includes growth since C and agrees with execution`: expected `would_recompact`, received `likely`.
- `C6b snapshot advisory is null while a newer compaction is pending`: expected `null`, received the older C as `likely`.
- `C6b snapshot advisory remembers a same-trigger would_recompact refusal`: expected `would_recompact`, received `likely`.

The small-growth advisory/execution contract and all existing undo cases passed. This run confirms the added regressions fail before the implementation change.

The DB test runner printed its Vitest failure summary, then remained in cleanup of its owned test databases. I interrupted that cleanup process (outer command exit 143) and removed only the databases named by that run. The test outcome above is Vitest's completed report, not the wrapper exit status.
