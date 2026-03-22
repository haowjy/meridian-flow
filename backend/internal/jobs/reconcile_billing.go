package jobs

import (
	"context"
	"log/slog"
	"time"

	billingrepo "meridian/internal/domain/repositories/billing"
	billingdomain "meridian/internal/domain/services/billing"
)

const (
	defaultReconcilePendingOlderThan = 5 * time.Minute
	defaultReconcileScanLimit        = 200
)

// ReconcileBillingJob retries pending billing settlements that were write-ahead persisted
// but failed to deduct from credits on the first attempt.
type ReconcileBillingJob struct {
	generationStore  billingrepo.GenerationBillingStore
	creditSettler    billingdomain.CreditSettler
	pendingOlderThan time.Duration
	scanLimit        int
	logger           *slog.Logger
}

func NewReconcileBillingJob(
	generationStore billingrepo.GenerationBillingStore,
	creditSettler billingdomain.CreditSettler,
	logger *slog.Logger,
) *ReconcileBillingJob {
	if logger == nil {
		logger = slog.Default()
	}

	return &ReconcileBillingJob{
		generationStore:  generationStore,
		creditSettler:    creditSettler,
		pendingOlderThan: defaultReconcilePendingOlderThan,
		scanLimit:        defaultReconcileScanLimit,
		logger:           logger,
	}
}

func (j *ReconcileBillingJob) Execute(ctx context.Context) error {
	olderThan := time.Now().Add(-j.pendingOlderThan)
	pending, err := j.generationStore.ListPendingSettlements(ctx, olderThan, j.scanLimit)
	if err != nil {
		return err
	}

	for _, item := range pending {
		retryErr := j.creditSettler.RetryPendingSettlement(ctx, billingdomain.RetryPendingSettlementInput{
			TurnID:       item.TurnID,
			RequestIndex: item.RequestIndex,
		})
		if retryErr != nil {
			j.logger.Warn("billing reconciliation retry failed",
				"turn_id", item.TurnID,
				"request_index", item.RequestIndex,
				"error", retryErr,
			)
			continue
		}

		j.logger.Debug("billing reconciliation retry succeeded",
			"turn_id", item.TurnID,
			"request_index", item.RequestIndex,
		)
	}

	j.logger.Info("billing reconciliation cycle complete",
		"pending_scanned", len(pending),
		"older_than", j.pendingOlderThan.String(),
	)

	return nil
}

func (j *ReconcileBillingJob) JobID() string {
	return "reconcile_billing"
}

func (j *ReconcileBillingJob) JobType() string {
	return "reconcile_billing"
}

func (j *ReconcileBillingJob) Retryable() bool {
	return false
}
