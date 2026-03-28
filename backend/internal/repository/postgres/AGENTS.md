# Postgres Repository Layer

Data access implementations using pgx/v5 with connection pooling. Architecture: `.meridian/fs/backend/overview.md`.

## GetExecutor Pattern

All repositories use `GetExecutor(ctx)` from `dbtx.go` to automatically participate in transactions:

```go
func (r *repo) DoThing(ctx context.Context, ...) error {
    db := postgres.GetExecutor(ctx, r.pool) // returns tx if in context, else pool
    _, err := db.Exec(ctx, query, args...)
    return err
}
```

When `TransactionManager.RunInTx()` wraps a call, the transaction is stored in context via `SetTx()`. All repository calls within that scope automatically use the transaction. No explicit `tx` parameter passing needed.

Defined in `dbtx.go`. `DBTX` interface: `Exec`, `Query`, `QueryRow` (satisfied by both `*pgxpool.Pool` and `pgx.Tx`).

## Table Prefix

All table names are dynamically prefixed (`dev_`, `test_`, `prod_`). Use `RepositoryConfig.Tables.*` -- never hardcode table names.

`TableNames` struct in `connection.go` holds all prefixed names. `NewTableNames(prefix)` initializes them.

`RepositoryConfig` bundles Pool + Tables + Logger for repository constructors.

## Migration Rules

See `backend/migrations/AGENTS.md` for full rules. Key points:
- `-- +goose ENVSUB ON` in all migrations
- `${TABLE_PREFIX}` for all table/index/constraint names
- Read existing migrations before writing new ones

## Connection Pooling

`CreateConnectionPool` in `connection.go`:
- Auto-detects PgBouncer (port 6543) and configures `QueryExecModeCacheDescribe`
- Default pool: 25 max, 5 min connections
- Health check: 5s period

## Repository Structure

Each domain has a subdirectory:
- `postgres/billing/` -- CreditStore, GenerationBillingStore
- `postgres/collab/` -- Proposal, state, update log, checkpoint, bookmark stores
- `postgres/docsystem/` -- Document, folder, project, favorite stores
- `postgres/llm/` -- Turn, thread stores
- Top-level: `connection.go`, `dbtx.go`, `errors.go`, `transaction.go`, `user_preferences.go`
