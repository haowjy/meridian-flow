package billing

import (
	"context"

)

// CreditSettler settles exact request usage into the credit ledger.
type CreditSettler interface {
	SettleAuthoritativeRequest(ctx context.Context, req SettleRequestInput) error
	RetryPendingSettlement(ctx context.Context, req RetryPendingSettlementInput) error
	MarkPendingSettlement(ctx context.Context, req MarkPendingSettlementInput) error
}

// ModelPricingResolver resolves billing pricing for a provider/model pair.
type ModelPricingResolver interface {
	ResolvePricing(provider, model string) (ModelPricing, error)
}

// SettleRequestInput is the settlement payload for one authoritative request.
type SettleRequestInput struct {
	UserID          string
	TurnID          string
	RequestIndex    int
	Provider        string
	Model           string
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
}

// RetryPendingSettlementInput identifies a previously persisted pending settlement.
type RetryPendingSettlementInput struct {
	TurnID       string
	RequestIndex int
}

// MarkPendingSettlementInput identifies a request that must remain pending
// until authoritative settlement data is available.
type MarkPendingSettlementInput struct {
	UserID       string
	TurnID       string
	RequestIndex int
	Model        string
	LastError    string
}
