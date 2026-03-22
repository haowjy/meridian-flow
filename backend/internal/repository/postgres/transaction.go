package postgres

import (
	"context"
	"fmt"
	"log/slog"
	"meridian/internal/domain"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TransactionManager implements the TransactionManager interface
type TransactionManager struct {
	pool *pgxpool.Pool
}

// NewTransactionManager creates a new transaction manager
func NewTransactionManager(pool *pgxpool.Pool) domain.TransactionManager {
	return &TransactionManager{pool: pool}
}

// ExecTx executes a function within a transaction
func (tm *TransactionManager) ExecTx(ctx context.Context, fn domain.TxFn) error {
	tx, err := tm.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}

	// Defer rollback - safe even if commit succeeds
	defer func() {
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			// Log rollback failure but don't return error (commit might have succeeded)
			slog.Error("rollback failed", "error", err)
		}
	}()

	// Store transaction in context so repositories can access it
	txCtx := SetTx(ctx, tx)

	// Execute function with transaction context
	if err := fn(txCtx); err != nil {
		return err
	}

	// Commit transaction
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}

	return nil
}
