# Projects TODO

## Keep bootstrap locks out of long awaits

`ensureDefaultBootstrapReady` currently provisions project and context rows
under the per-user advisory lock while document seeding and post-write effects
may await. If one await stalls, later sign-ins and database reset wait on that
transaction. Keep the rows that need atomicity under the lock, then move seeding
and effects into an idempotent completion step after commit. Configure an
idle-in-transaction timeout for the app role as a defensive limit.
