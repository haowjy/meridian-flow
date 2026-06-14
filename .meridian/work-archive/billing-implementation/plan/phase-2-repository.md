# Phase 2: Repository Layer (CreditStore)

## Scope

Implement the PostgreSQL CreditStore that backs all billing persistence. This is the data access layer — it calls SQL/plpgsql, not business logic.

## Dependencies

- Phase 1: domain types, interfaces, migration

## Files to Create

### Repository Implementation

- `backend/internal/repository/postgres/billing/credit_store.go`
  - Implements `billing.CreditStore` from `domain/repositories/billing/`
  - Constructor: `NewCreditStore(db dbtx.DBTX, tablePrefix string) *CreditStore`
  - Follow the pattern in `backend/internal/repository/postgres/llm/turn.go` — use `db.Tables.*` for table names

  Methods:

  - `GetBalance(ctx, userID) (*CreditBalance, error)`
    - Query the `credit_balances` view
    - Return zero balance (not error) for users with no lots

  - `ListTransactions(ctx, userID, ListTransactionsRequest) (*CreditTransactionPage, error)`
    - Paginated query on `credit_transactions`
    - Order by `created_at DESC, id DESC`
    - Include count query for total
    - Limit/offset from request

  - `CreatePurchaseLot(ctx, CreatePurchaseLotRequest) error`
    - Insert into `credit_lots` with `source_type = 'purchase'`
    - Insert matching `credit_transactions` with `transaction_type = 'purchase'`
    - Both in a single transaction
    - `stripe_session_id` is set, `grant_reason` is NULL

  - `CreateGrantLot(ctx, CreateGrantLotRequest) error`
    - Insert into `credit_lots` with `source_type = 'grant'`
    - Insert matching `credit_transactions` with `transaction_type = 'grant'`
    - `grant_reason` is set, `stripe_session_id` is NULL
    - `expires_at` set from request

  - `ConsumeFIFO(ctx, ConsumeFIFORequest) error`
    - Call `${TABLE_PREFIX}consume_credit_lots_fifo(...)` PL/pgSQL function
    - Map Go params to SQL function params
    - Handle the `credit_anchor_missing` exception as a domain error

  - `ExpireAvailableLots(ctx, nowUTC, batchSize) ([]ExpiredLot, error)`
    - Run the expiration CTE from billing-design.md
    - `FOR UPDATE SKIP LOCKED` for concurrency safety
    - Return expired lot details for logging

### Table Names Registration

- `backend/internal/repository/postgres/connection.go` (MODIFY)
  - Add billing fields to `TableNames` struct:
    ```go
    // Billing tables
    CreditLots            string
    CreditTransactions    string
    CreditBalances        string // view
    ConsumeCreditLotsFIFO string // function name
    ```
  - Add to `NewTableNames(prefix)`:
    ```go
    CreditLots:            fmt.Sprintf("%scredit_lots", prefix),
    CreditTransactions:    fmt.Sprintf("%scredit_transactions", prefix),
    CreditBalances:        fmt.Sprintf("%scredit_balances", prefix),
    ConsumeCreditLotsFIFO: fmt.Sprintf("%sconsume_credit_lots_fifo", prefix),
    ```
  - The repository uses `r.tables.CreditLots` etc. in SQL queries via `fmt.Sprintf`

### Tests

- `backend/internal/repository/postgres/billing/credit_store_test.go`
  - Integration tests that run against local Supabase
  - Test FIFO ordering (promotional before purchased)
  - Test idempotent ConsumeFIFO (same consumption_group_id)
  - Test negative balance anchor behavior
  - Test expiration filtering in balance view
  - Test CreatePurchaseLot idempotency (duplicate stripe_session_id)
  - Test CreateGrantLot idempotency (duplicate user_id + grant_reason)
  - Test ListTransactions pagination

## Patterns to Follow

- Repository pattern: `backend/internal/repository/postgres/llm/turn.go`
- Table name resolution: `backend/internal/repository/postgres/dbtx.go` and `connection.go`
- Transaction management: `backend/internal/repository/postgres/transaction.go`

## Interface Contract

```go
type CreditStore interface {
    GetBalance(ctx context.Context, userID string) (*CreditBalance, error)
    ListTransactions(ctx context.Context, userID string, req ListTransactionsRequest) (*CreditTransactionPage, error)
    CreatePurchaseLot(ctx context.Context, req CreatePurchaseLotRequest) error
    CreateGrantLot(ctx context.Context, req CreateGrantLotRequest) error
    ConsumeFIFO(ctx context.Context, req ConsumeFIFORequest) error
    ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]ExpiredLot, error)
}
```

## Constraints

- Use `db.Tables.*` for all table/view/function references — never hardcode table names
- All SQL must use `$1, $2...` parameter placeholders
- Follow existing `pgx` usage patterns (not `database/sql`)
- ConsumeFIFO must handle the PL/pgSQL exception by checking the error message prefix

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./internal/repository/postgres/billing/...` passes (needs local Supabase)
- [ ] FIFO ordering test: create promotional lot + purchased lot, consume — promotional deducted first
- [ ] Idempotency test: call ConsumeFIFO twice with same group_id — second call is a no-op
- [ ] Balance after consumption matches expected remaining
