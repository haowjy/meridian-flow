package repositories

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is an interface that both *pgxpool.Pool and pgx.Tx implement
// This allows repositories to work with both regular connections and transactions
type DBTX interface {
	Exec(ctx context.Context, sql string, arguments ...interface{}) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, arguments ...interface{}) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, arguments ...interface{}) pgx.Row
}

// txContextKey is the type for transaction context keys
type txContextKey string

// txKey is the context key for storing transactions
const txKey txContextKey = "pgx_tx"

// SetTx stores a transaction in the context
func SetTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey, tx)
}

// GetTx retrieves a transaction from the context
// Returns nil if no transaction is present
func GetTx(ctx context.Context) pgx.Tx {
	tx, ok := ctx.Value(txKey).(pgx.Tx)
	if !ok {
		return nil
	}
	return tx
}
