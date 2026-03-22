package jobs

import (
	"context"
	"log/slog"
	"time"

	billingrepo "meridian/internal/domain/repositories/billing"
)

const defaultExpireCreditsBatchSize = 500

// ExpireCreditsJob expires promotional credit lots that reached their expiry timestamp.
type ExpireCreditsJob struct {
	creditStore billingrepo.CreditStore
	batchSize   int
	nowFn       func() time.Time
	logger      *slog.Logger
}

func NewExpireCreditsJob(creditStore billingrepo.CreditStore, logger *slog.Logger) *ExpireCreditsJob {
	if logger == nil {
		logger = slog.Default()
	}

	return &ExpireCreditsJob{
		creditStore: creditStore,
		batchSize:   defaultExpireCreditsBatchSize,
		nowFn:       time.Now,
		logger:      logger,
	}
}

func (j *ExpireCreditsJob) Execute(ctx context.Context) error {
	nowUTC := j.nowFn().UTC().Format(time.RFC3339)
	expired, err := j.creditStore.ExpireAvailableLots(ctx, nowUTC, j.batchSize)
	if err != nil {
		return err
	}

	j.logger.Info("credit expiration cycle complete",
		"expired_lot_count", len(expired),
		"batch_size", j.batchSize,
		"timestamp_utc", nowUTC,
	)
	return nil
}

func (j *ExpireCreditsJob) JobID() string {
	return "expire_credits"
}

func (j *ExpireCreditsJob) JobType() string {
	return "expire_credits"
}

func (j *ExpireCreditsJob) Retryable() bool {
	return false
}
