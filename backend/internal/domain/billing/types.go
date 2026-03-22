package billing

import (
	"time"

	"github.com/google/uuid"
)

// JSONMap is a type alias for JSONB fields.
type JSONMap = map[string]interface{}

type CreditSourceType string

const (
	CreditSourceTypePurchase CreditSourceType = "purchase"
	CreditSourceTypeGrant    CreditSourceType = "grant"
)

type CreditTransactionType string

const (
	CreditTransactionTypePurchase    CreditTransactionType = "purchase"
	CreditTransactionTypeGrant       CreditTransactionType = "grant"
	CreditTransactionTypeConsumption CreditTransactionType = "consumption"
	CreditTransactionTypeExpiration  CreditTransactionType = "expiration"
	CreditTransactionTypeRefund      CreditTransactionType = "refund"
)

type CreditSettlementMode string

const (
	CreditSettlementInlineAuthoritative  CreditSettlementMode = "inline_authoritative"
	CreditSettlementDeferredToEnrichment CreditSettlementMode = "deferred_to_enrichment"
)

// CreditBalance stores per-user millicredit balances.
type CreditBalance struct {
	TotalBalanceMillicredits       int64 `json:"total_balance_millicredits" db:"total_balance_millicredits"`
	PromotionalBalanceMillicredits int64 `json:"promotional_balance_millicredits" db:"promotional_balance_millicredits"`
	PurchasedBalanceMillicredits   int64 `json:"purchased_balance_millicredits" db:"purchased_balance_millicredits"`
	DebtBalanceMillicredits        int64 `json:"debt_balance_millicredits" db:"debt_balance_millicredits"`
}

// CreditPack is a backend-authoritative SKU definition.
type CreditPack struct {
	PackID       string `json:"pack_id"`
	Label        string `json:"label"`
	PriceCents   int64  `json:"price_cents"`
	Credits      int64  `json:"credits"`
	BonusCredits int64  `json:"bonus_credits"`
}

// CreditTransaction represents one audit ledger row.
type CreditTransaction struct {
	ID                 uuid.UUID             `json:"id" db:"id"`
	UserID             string                `json:"user_id" db:"user_id"`
	TransactionType    CreditTransactionType `json:"transaction_type" db:"transaction_type"`
	AmountMillicredits int64                 `json:"amount_millicredits" db:"amount_millicredits"`
	LotID              *uuid.UUID            `json:"lot_id,omitempty" db:"lot_id"`
	ConsumptionGroupID *uuid.UUID            `json:"consumption_group_id,omitempty" db:"consumption_group_id"`
	UsageEventID       *string               `json:"usage_event_id,omitempty" db:"usage_event_id"`
	Metadata           JSONMap               `json:"metadata,omitempty" db:"metadata"`
	CreatedAt          time.Time             `json:"created_at" db:"created_at"`
}

// CreditLot is the source-of-truth balance row.
type CreditLot struct {
	ID                         uuid.UUID        `json:"id" db:"id"`
	UserID                     string           `json:"user_id" db:"user_id"`
	SourceType                 CreditSourceType `json:"source_type" db:"source_type"`
	OriginalAmountMillicredits int64            `json:"original_amount_millicredits" db:"original_amount_millicredits"`
	RemainingMillicredits      int64            `json:"remaining_millicredits" db:"remaining_millicredits"`
	ExpiresAt                  *time.Time       `json:"expires_at,omitempty" db:"expires_at"`
	StripeSessionID            *string          `json:"stripe_session_id,omitempty" db:"stripe_session_id"`
	GrantReason                *string          `json:"grant_reason,omitempty" db:"grant_reason"`
	Metadata                   JSONMap          `json:"metadata,omitempty" db:"metadata"`
	CreatedAt                  time.Time        `json:"created_at" db:"created_at"`
}

// CheckoutSession contains Stripe checkout redirect information.
type CheckoutSession struct {
	SessionID   string    `json:"session_id"`
	CheckoutURL string    `json:"checkout_url"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// TokenUsage contains authoritative token counts for a billable step.
type TokenUsage struct {
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
}

// ModelPricing contains per-model pricing and markup in microusd.
type ModelPricing struct {
	InputMicrousdPer1K     int64
	OutputMicrousdPer1K    int64
	ReasoningMicrousdPer1K int64
	CachedMicrousdPer1K    int64
	MarkupBasisPoints      int64
}

// ListTransactionsRequest controls pagination for transaction history.
// Lives in models (not services) so both CreditStore and CreditService can reference it
// without creating a circular import between domain/repositories and domain/services.
type ListTransactionsRequest struct {
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
}

// CreditTransactionPage is a paginated transaction response.
type CreditTransactionPage struct {
	Items  []CreditTransaction `json:"items"`
	Limit  int                 `json:"limit"`
	Offset int                 `json:"offset"`
	Total  int                 `json:"total"`
}
