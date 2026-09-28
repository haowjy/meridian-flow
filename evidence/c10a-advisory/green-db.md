# Post-fix DB contracts

Command: `PGOPTIONS='-c client_min_messages=warning' pnpm test:db -- apps/server/server/domains/runtime/loop/compaction-undo.db.test.ts -t 'C6b snapshot advisory'`

Result: Vitest passed. Five advisory cases passed; 21 unrelated cases in the same file were skipped by the title filter. The outer runner dropped all four worker databases and its owned database.
