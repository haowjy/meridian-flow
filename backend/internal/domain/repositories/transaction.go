package repositories

import "context"

// TxFn is a function that runs within a transaction
type TxFn func(ctx context.Context) error

// TransactionManager handles database transactions
type TransactionManager interface {
	// ExecTx executes a function within a transaction
	ExecTx(ctx context.Context, fn TxFn) error
}
