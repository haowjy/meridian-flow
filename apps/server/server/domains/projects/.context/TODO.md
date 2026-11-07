# Projects TODO

## Keep bootstrap locks out of long awaits

`ensureDefaultBootstrapReady` provisions rows under the per-user advisory lock
while document seeding and post-write effects await, so one stall blocks later
sign-ins and database reset. Move seeding and effects into an idempotent
completion step after commit, and configure an idle-in-transaction timeout for
the app role.
