package billing

import (
	"context"

	billing "meridian/internal/domain/billing"
)

var (
	_ billing.CreditAdmissionChecker = (*NoopCreditAdmissionChecker)(nil)
	_ billing.CreditSettler          = (*NoopCreditSettler)(nil)
)

// NoopCreditAdmissionChecker always admits requests (dev/test wiring only).
type NoopCreditAdmissionChecker struct{}

func NewNoopCreditAdmissionChecker() *NoopCreditAdmissionChecker {
	return &NoopCreditAdmissionChecker{}
}

func (c *NoopCreditAdmissionChecker) CheckAdmission(ctx context.Context, userID string) error {
	return nil
}

func (c *NoopCreditAdmissionChecker) HasPurchasedCredits(ctx context.Context, userID string) bool {
	return true // Noop assumes paid (no restrictions in dev/test)
}

// NoopCreditSettler always succeeds settlement calls (dev/test wiring only).
type NoopCreditSettler struct{}

func NewNoopCreditSettler() *NoopCreditSettler {
	return &NoopCreditSettler{}
}

func (s *NoopCreditSettler) SettleAuthoritativeRequest(ctx context.Context, req billing.SettleRequestInput) error {
	return nil
}

func (s *NoopCreditSettler) RetryPendingSettlement(ctx context.Context, req billing.RetryPendingSettlementInput) error {
	return nil
}

func (s *NoopCreditSettler) MarkPendingSettlement(ctx context.Context, req billing.MarkPendingSettlementInput) error {
	return nil
}
