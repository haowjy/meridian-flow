# Projects TODO

## Sign-in bootstrap can hold the per-user lock indefinitely ([#596](https://github.com/haowjy/meridian-flow/issues/596))

`ensureDefaultBootstrapReady` runs one transaction under the per-user advisory
lock that provisions the project and context sources, then awaits document
creation. That includes manifest membership, Yjs seeding, and post-write hooks
(`index.ts` `ensureDocument`). If any of those awaits never resolves, the
transaction stays idle in transaction with the lock held. Every later request
for that user then waits, and so does `pnpm db:reset`. Observed in dev
2026-09-25; the hung await is unknown.

Reproduce with concurrent first sign-ins for a fresh user. Then keep the lock
and transaction to the rows that need atomicity, and move seeding and effects
after commit as an idempotent completion step. Also set
`idle_in_transaction_session_timeout` for the app role.
