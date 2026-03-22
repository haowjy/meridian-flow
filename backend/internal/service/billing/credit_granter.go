package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	billing "meridian/internal/domain/billing"
)

var _ billing.CreditGranter = (*creditGranter)(nil)

type creditGranter struct {
	store  billing.CreditStore
	logger *slog.Logger
	now    func() time.Time
}

func NewCreditGranter(store billing.CreditStore, logger *slog.Logger) *creditGranter {
	if logger == nil {
		logger = slog.Default()
	}

	return &creditGranter{
		store:  store,
		logger: logger,
		now:    time.Now,
	}
}

// InitializeSignupCredits grants the user's first monthly credit refresh.
// There is no separate signup bonus — all users get the same monthly refresh on login.
func (g *creditGranter) InitializeSignupCredits(
	ctx context.Context,
	req billing.InitializeSignupCreditsRequest,
) (*billing.InitializeSignupCreditsResult, error) {
	if !req.EmailVerified {
		return &billing.InitializeSignupCreditsResult{}, nil
	}

	result, err := g.RefreshMonthlyCredits(ctx, req.UserID)
	if err != nil {
		return nil, err
	}

	balance, err := g.store.GetBalance(ctx, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("get balance after signup: %w", err)
	}
	if balance == nil {
		balance = &billing.CreditBalance{}
	}

	var creditsGranted int64
	if result.CreditsGranted {
		creditsGranted = billing.MonthlyRefreshMillicredits
	}

	return &billing.InitializeSignupCreditsResult{
		CreditsGranted:                 creditsGranted,
		AlreadyInitialized:             !result.CreditsGranted,
		PromotionalBalanceMillicredits: balance.PromotionalBalanceMillicredits,
		PurchasedBalanceMillicredits:   balance.PurchasedBalanceMillicredits,
		TotalBalanceMillicredits:       balance.TotalBalanceMillicredits,
	}, nil
}

func (g *creditGranter) RefreshMonthlyCredits(
	ctx context.Context,
	userID string,
) (*billing.MonthlyRefreshResult, error) {
	// Grant reason is unique per calendar month — idempotent via unique index.
	now := g.now().UTC()
	grantReason := fmt.Sprintf("monthly_refresh_%s", now.Format("2006_01"))

	expiresAt := now.AddDate(0, 0, billing.MonthlyRefreshExpirationDays)
	grantErr := g.store.CreateGrantLot(ctx, billing.CreateGrantLotRequest{
		UserID:             userID,
		AmountMillicredits: billing.MonthlyRefreshMillicredits,
		ExpiresAt:          &expiresAt,
		GrantReason:        grantReason,
		Metadata: billing.JSONMap{
			"type": "monthly_refresh",
		},
	})
	if grantErr != nil {
		if errors.Is(grantErr, billing.ErrGrantLotAlreadyExists) || isDuplicateGrantError(grantErr) {
			// Already granted this month — no-op
			return &billing.MonthlyRefreshResult{
				CreditsGranted: false,
				GrantReason:    grantReason,
			}, nil
		}
		return nil, fmt.Errorf("create monthly refresh grant: %w", grantErr)
	}

	g.logger.Info("granted monthly credit refresh",
		"user_id", userID,
		"grant_reason", grantReason,
		"amount_millicredits", billing.MonthlyRefreshMillicredits,
	)

	return &billing.MonthlyRefreshResult{
		CreditsGranted: true,
		GrantReason:    grantReason,
	}, nil
}

func isDuplicateGrantError(err error) bool {
	if err == nil {
		return false
	}

	if errors.Is(err, ErrDuplicateGrantInitialization) {
		return true
	}

	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "duplicate key value") ||
		strings.Contains(lower, "unique constraint") ||
		(strings.Contains(lower, "duplicate") && strings.Contains(lower, "grant"))
}

var ErrDuplicateGrantInitialization = errors.New("duplicate grant initialization")
