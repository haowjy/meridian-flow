package billing

import (
	"context"

	billingdomain "meridian/internal/domain/services/billing"
)

var (
	_ billingdomain.CreditAdmissionChecker = (*NoopCreditAdmissionChecker)(nil)
	_ billingdomain.CreditSettler          = (*NoopCreditSettler)(nil)
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

func (s *NoopCreditSettler) SettleAuthoritativeRequest(ctx context.Context, req billingdomain.SettleRequestInput) error {
	return nil
}

func (s *NoopCreditSettler) RetryPendingSettlement(ctx context.Context, req billingdomain.RetryPendingSettlementInput) error {
	return nil
}

func (s *NoopCreditSettler) MarkPendingSettlement(ctx context.Context, req billingdomain.MarkPendingSettlementInput) error {
	return nil
}
