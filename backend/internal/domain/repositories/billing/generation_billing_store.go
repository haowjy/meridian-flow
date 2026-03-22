package billing

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// BillingFields stores persisted settlement data for one generation request index.
type BillingFields struct {
	UserID             string
	UsageEventID       string
	ConsumptionGroupID uuid.UUID
	AmountMillicredits int64
	Status             string
	LastError          string
	RetryCount         int
}

// PendingSettlement identifies one pending generation settlement to retry.
type PendingSettlement struct {
	TurnID       string
	RequestIndex int
	Billing      BillingFields
}

// GenerationBillingStore persists settlement fields/status on generation records.
type GenerationBillingStore interface {
	SetBillingFields(ctx context.Context, turnID string, requestIndex int, fields BillingFields) error
	GetBillingFields(ctx context.Context, turnID string, requestIndex int) (*BillingFields, error)
	MarkBillingStatus(ctx context.Context, turnID string, requestIndex int, status string, lastError string) error
	ListPendingSettlements(ctx context.Context, olderThan time.Time, limit int) ([]PendingSettlement, error)
}
