package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	billingmodel "meridian/internal/domain/models/billing"
	billingrepo "meridian/internal/domain/repositories/billing"
	"meridian/internal/repository/postgres"
)

const consumeCreditLotsFIFOSuffix = "consume_credit_lots_fifo"

type CreditStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

var _ billingrepo.CreditStore = (*CreditStore)(nil)

func NewCreditStore(config *postgres.RepositoryConfig) billingrepo.CreditStore {
	return &CreditStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

func (r *CreditStore) GetBalance(ctx context.Context, userID string) (*billingmodel.CreditBalance, error) {
	query := fmt.Sprintf(`
		SELECT
			total_balance_millicredits,
			promotional_balance_millicredits,
			purchased_balance_millicredits,
			debt_balance_millicredits
		FROM %s
		WHERE user_id = $1
	`, r.tables.CreditBalances)

	balance := &billingmodel.CreditBalance{}
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, userID).Scan(
		&balance.TotalBalanceMillicredits,
		&balance.PromotionalBalanceMillicredits,
		&balance.PurchasedBalanceMillicredits,
		&balance.DebtBalanceMillicredits,
	)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return &billingmodel.CreditBalance{}, nil
		}
		return nil, fmt.Errorf("get credit balance: %w", err)
	}

	return balance, nil
}

func (r *CreditStore) ListTransactions(
	ctx context.Context,
	userID string,
	req billingmodel.ListTransactionsRequest,
) (*billingmodel.CreditTransactionPage, error) {
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE user_id = $1
	`, r.tables.CreditTransactions)

	var total int
	executor := postgres.GetExecutor(ctx, r.pool)
	if err := executor.QueryRow(ctx, countQuery, userID).Scan(&total); err != nil {
		return nil, fmt.Errorf("count credit transactions: %w", err)
	}

	query := fmt.Sprintf(`
		SELECT
			id,
			user_id,
			transaction_type,
			amount_millicredits,
			lot_id,
			consumption_group_id,
			usage_event_id,
			metadata,
			created_at
		FROM %s
		WHERE user_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2 OFFSET $3
	`, r.tables.CreditTransactions)

	rows, err := executor.Query(ctx, query, userID, req.Limit, req.Offset)
	if err != nil {
		return nil, fmt.Errorf("list credit transactions: %w", err)
	}
	defer rows.Close()

	items := make([]billingmodel.CreditTransaction, 0)
	for rows.Next() {
		var item billingmodel.CreditTransaction
		if scanErr := rows.Scan(
			&item.ID,
			&item.UserID,
			&item.TransactionType,
			&item.AmountMillicredits,
			&item.LotID,
			&item.ConsumptionGroupID,
			&item.UsageEventID,
			&item.Metadata,
			&item.CreatedAt,
		); scanErr != nil {
			return nil, fmt.Errorf("scan credit transaction: %w", scanErr)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate credit transactions: %w", err)
	}

	return &billingmodel.CreditTransactionPage{
		Items:  items,
		Limit:  req.Limit,
		Offset: req.Offset,
		Total:  total,
	}, nil
}

func (r *CreditStore) CreatePurchaseLot(ctx context.Context, req billingrepo.CreatePurchaseLotRequest) error {
	return r.withTx(ctx, func(txCtx context.Context, tx pgx.Tx) error {
		insertLotQuery := fmt.Sprintf(`
			INSERT INTO %s (
				user_id,
				source_type,
				original_amount_millicredits,
				remaining_millicredits,
				expires_at,
				stripe_session_id,
				grant_reason,
				metadata,
				created_at
			)
			VALUES ($1, 'purchase', $2, $2, $3, $4, NULL, COALESCE($5, '{}'::jsonb), NOW())
			ON CONFLICT DO NOTHING
			RETURNING id
		`, r.tables.CreditLots)

		var lotID uuid.UUID
		err := tx.QueryRow(txCtx, insertLotQuery,
			req.UserID,
			req.AmountMillicredits,
			req.ExpiresAt,
			req.StripeSessionID,
			req.Metadata,
		).Scan(&lotID)
		if err != nil {
			if postgres.IsPgNoRowsError(err) {
				return nil
			}
			return fmt.Errorf("insert purchase lot: %w", err)
		}

		insertTxnQuery := fmt.Sprintf(`
			INSERT INTO %s (
				user_id,
				transaction_type,
				amount_millicredits,
				lot_id,
				metadata,
				created_at
			)
			VALUES ($1, 'purchase', $2, $3, COALESCE($4, '{}'::jsonb), NOW())
		`, r.tables.CreditTransactions)

		if _, err := tx.Exec(txCtx, insertTxnQuery,
			req.UserID,
			req.AmountMillicredits,
			lotID,
			req.Metadata,
		); err != nil {
			return fmt.Errorf("insert purchase transaction: %w", err)
		}

		return nil
	})
}

func (r *CreditStore) CreateGrantLot(ctx context.Context, req billingrepo.CreateGrantLotRequest) error {
	return r.withTx(ctx, func(txCtx context.Context, tx pgx.Tx) error {
		insertLotQuery := fmt.Sprintf(`
			INSERT INTO %s (
				user_id,
				source_type,
				original_amount_millicredits,
				remaining_millicredits,
				expires_at,
				stripe_session_id,
				grant_reason,
				metadata,
				created_at
			)
			VALUES ($1, 'grant', $2, $2, $3, NULL, $4, COALESCE($5, '{}'::jsonb), NOW())
			ON CONFLICT DO NOTHING
			RETURNING id
		`, r.tables.CreditLots)

		var lotID uuid.UUID
		err := tx.QueryRow(txCtx, insertLotQuery,
			req.UserID,
			req.AmountMillicredits,
			req.ExpiresAt,
			req.GrantReason,
			req.Metadata,
		).Scan(&lotID)
		if err != nil {
			if postgres.IsPgNoRowsError(err) {
				return billingrepo.ErrGrantLotAlreadyExists
			}
			return fmt.Errorf("insert grant lot: %w", err)
		}

		insertTxnQuery := fmt.Sprintf(`
			INSERT INTO %s (
				user_id,
				transaction_type,
				amount_millicredits,
				lot_id,
				metadata,
				created_at
			)
			VALUES ($1, 'grant', $2, $3, COALESCE($4, '{}'::jsonb), NOW())
		`, r.tables.CreditTransactions)

		if _, err := tx.Exec(txCtx, insertTxnQuery,
			req.UserID,
			req.AmountMillicredits,
			lotID,
			req.Metadata,
		); err != nil {
			return fmt.Errorf("insert grant transaction: %w", err)
		}

		return nil
	})
}

func (r *CreditStore) RefundLot(ctx context.Context, req billingrepo.RefundLotRequest) error {
	return r.withTx(ctx, func(txCtx context.Context, tx pgx.Tx) error {
		selectLotQuery := fmt.Sprintf(`
			SELECT
				id,
				user_id,
				original_amount_millicredits,
				remaining_millicredits
			FROM %s
			WHERE stripe_session_id = $1
			FOR UPDATE
		`, r.tables.CreditLots)

		var lotID uuid.UUID
		var userID string
		var originalAmountMillicredits int64
		var remainingMillicredits int64
		err := tx.QueryRow(txCtx, selectLotQuery, req.StripeSessionID).Scan(
			&lotID,
			&userID,
			&originalAmountMillicredits,
			&remainingMillicredits,
		)
		if err != nil {
			if postgres.IsPgNoRowsError(err) {
				return billingrepo.ErrRefundLotNotFound
			}
			return fmt.Errorf("select refund lot by stripe session id: %w", err)
		}

		alreadyRefundedQuery := fmt.Sprintf(`
			SELECT EXISTS (
				SELECT 1
				FROM %s
				WHERE lot_id = $1
					AND transaction_type = 'refund'
			)
		`, r.tables.CreditTransactions)

		var alreadyRefunded bool
		if err := tx.QueryRow(txCtx, alreadyRefundedQuery, lotID).Scan(&alreadyRefunded); err != nil {
			return fmt.Errorf("check existing refund transaction: %w", err)
		}
		if alreadyRefunded {
			return nil
		}

		newRemainingMillicredits := remainingMillicredits - originalAmountMillicredits

		updateLotQuery := fmt.Sprintf(`
			UPDATE %s
			SET remaining_millicredits = $2
			WHERE id = $1
		`, r.tables.CreditLots)

		if _, err := tx.Exec(txCtx, updateLotQuery, lotID, newRemainingMillicredits); err != nil {
			return fmt.Errorf("update refund lot remaining balance: %w", err)
		}

		insertTxnQuery := fmt.Sprintf(`
			INSERT INTO %s (
				user_id,
				transaction_type,
				amount_millicredits,
				lot_id,
				metadata,
				created_at
			)
			VALUES ($1, 'refund', $2, $3, COALESCE($4, '{}'::jsonb), NOW())
		`, r.tables.CreditTransactions)

		if _, err := tx.Exec(txCtx, insertTxnQuery,
			userID,
			-originalAmountMillicredits,
			lotID,
			req.Metadata,
		); err != nil {
			return fmt.Errorf("insert refund transaction: %w", err)
		}

		return nil
	})
}

func (r *CreditStore) ConsumeFIFO(ctx context.Context, req billingrepo.ConsumeFIFORequest) error {
	query := fmt.Sprintf(`
		SELECT lot_id, amount_millicredits
		FROM %s($1, $2, $3, $4, $5)
	`, r.tables.ConsumeCreditLotsFIFO)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query,
		req.UserID,
		req.AmountMillicredits,
		req.ConsumptionGroupID,
		req.UsageEventID,
		req.Metadata,
	)
	if err != nil {
		if r.isCreditAnchorMissingError(err) {
			return domain.NewInsufficientCreditsError(0, req.AmountMillicredits)
		}
		return fmt.Errorf("consume credits fifo: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var lotID uuid.UUID
		var amount int64
		if err := rows.Scan(&lotID, &amount); err != nil {
			return fmt.Errorf("scan consume fifo result: %w", err)
		}
	}

	if err := rows.Err(); err != nil {
		if r.isCreditAnchorMissingError(err) {
			return domain.NewInsufficientCreditsError(0, req.AmountMillicredits)
		}
		return fmt.Errorf("consume credits fifo rows: %w", err)
	}

	return nil
}

func (r *CreditStore) ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]billingrepo.ExpiredLot, error) {
	if batchSize <= 0 {
		return []billingrepo.ExpiredLot{}, nil
	}

	query := fmt.Sprintf(`
		WITH expired AS (
			SELECT id, user_id, remaining_millicredits
			FROM %s
			WHERE expires_at IS NOT NULL
				AND expires_at <= $1::timestamptz
				AND remaining_millicredits > 0
			ORDER BY expires_at, created_at, id
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		),
		updated AS (
			UPDATE %s l
			SET remaining_millicredits = 0
			FROM expired e
			WHERE l.id = e.id
			RETURNING e.id, e.user_id, e.remaining_millicredits
		)
		INSERT INTO %s (
			id,
			user_id,
			transaction_type,
			amount_millicredits,
			lot_id,
			metadata,
			created_at
		)
		SELECT
			gen_random_uuid(),
			user_id,
			'expiration',
			-remaining_millicredits,
			id,
			'{}'::jsonb,
			$1::timestamptz
		FROM updated
		RETURNING lot_id, user_id, -amount_millicredits
	`, r.tables.CreditLots, r.tables.CreditLots, r.tables.CreditTransactions)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, nowUTC, batchSize)
	if err != nil {
		return nil, fmt.Errorf("expire available lots: %w", err)
	}
	defer rows.Close()

	expiredLots := make([]billingrepo.ExpiredLot, 0)
	for rows.Next() {
		var expired billingrepo.ExpiredLot
		if err := rows.Scan(&expired.LotID, &expired.UserID, &expired.AmountMillicredits); err != nil {
			return nil, fmt.Errorf("scan expired lot: %w", err)
		}
		expiredLots = append(expiredLots, expired)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate expired lots: %w", err)
	}

	return expiredLots, nil
}

func (r *CreditStore) withTx(ctx context.Context, fn func(context.Context, pgx.Tx) error) error {
	if tx := postgres.GetTx(ctx); tx != nil {
		return fn(ctx, tx)
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin credit store transaction: %w", err)
	}
	defer func() {
		if rbErr := tx.Rollback(ctx); rbErr != nil && rbErr != pgx.ErrTxClosed {
			if r.logger != nil {
				r.logger.Error("credit store rollback failed", "error", rbErr)
			}
		}
	}()

	txCtx := postgres.SetTx(ctx, tx)
	if err := fn(txCtx, tx); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit credit store transaction: %w", err)
	}

	return nil
}

func (r *CreditStore) isCreditAnchorMissingError(err error) bool {
	errPrefix := strings.TrimSuffix(r.tables.ConsumeCreditLotsFIFO, consumeCreditLotsFIFOSuffix) + "credit_anchor_missing"

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if errPrefix != "credit_anchor_missing" && strings.HasPrefix(pgErr.Message, errPrefix) {
			return true
		}
		if strings.HasPrefix(pgErr.Message, "cannot anchor negative balance") {
			return true
		}
	}

	msg := err.Error()
	if errPrefix != "credit_anchor_missing" && strings.HasPrefix(msg, errPrefix) {
		return true
	}

	return strings.Contains(msg, "cannot anchor negative balance")
}
