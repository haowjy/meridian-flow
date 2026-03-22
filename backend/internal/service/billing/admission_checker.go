package billing

import (
	"context"
	"log/slog"

	"meridian/internal/domain"
	billingrepo "meridian/internal/domain/repositories/billing"
	billingdomain "meridian/internal/domain/services/billing"
)

var _ billingdomain.CreditAdmissionChecker = (*creditAdmissionChecker)(nil)

type creditAdmissionChecker struct {
	store  billingrepo.CreditStore
	logger *slog.Logger
}

func NewCreditAdmissionChecker(store billingrepo.CreditStore, logger *slog.Logger) *creditAdmissionChecker {
	if logger == nil {
		logger = slog.Default()
	}

	return &creditAdmissionChecker{
		store:  store,
		logger: logger,
	}
}

func (c *creditAdmissionChecker) HasPurchasedCredits(ctx context.Context, userID string) bool {
	balance, err := c.store.GetBalance(ctx, userID)
	if err != nil || balance == nil {
		return false
	}
	return balance.PurchasedBalanceMillicredits > 0
}

func (c *creditAdmissionChecker) CheckAdmission(ctx context.Context, userID string) error {
	balance, err := c.store.GetBalance(ctx, userID)
	if err != nil {
		c.logger.Warn("credit admission denied due to balance lookup failure",
			"user_id", userID,
			"error", err,
		)
		return err
	}

	if balance == nil || balance.TotalBalanceMillicredits <= 0 {
		current := int64(0)
		if balance != nil {
			current = balance.TotalBalanceMillicredits
		}
		return domain.NewInsufficientCreditsError(current, 1)
	}

	return nil
}
