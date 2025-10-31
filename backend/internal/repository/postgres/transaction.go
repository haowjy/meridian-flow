package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jimmyyao/meridian/backend/internal/domain/repositories"
)

// TransactionManager implements the TransactionManager interface
type TransactionManager struct {
	pool *pgxpool.Pool
}

// NewTransactionManager creates a new transaction manager
func NewTransactionManager(pool *pgxpool.Pool) repositories.TransactionManager {
	return &TransactionManager{pool: pool}
}

// ExecTx executes a function within a transaction
func (tm *TransactionManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	tx, err := tm.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}

	// Defer rollback - safe even if commit succeeds
	defer func() {
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			// Log rollback failure but don't return error (commit might have succeeded)
			fmt.Printf("rollback failed: %v\n", err)
		}
	}()

	// Execute function with transaction context
	if err := fn(ctx); err != nil {
		return err
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}

	return nil
}
