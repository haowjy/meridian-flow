package billing

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	billingmodel "meridian/internal/domain/models/billing"
)

var ErrGrantLotAlreadyExists = errors.New("grant lot already exists")
var ErrRefundLotNotFound = errors.New("refund lot not found")

// CreditStore defines persistence operations for billing credits.
type CreditStore interface {
	GetBalance(ctx context.Context, userID string) (*billingmodel.CreditBalance, error)
	ListTransactions(ctx context.Context, userID string, req billingmodel.ListTransactionsRequest) (*billingmodel.CreditTransactionPage, error)
	CreatePurchaseLot(ctx context.Context, req CreatePurchaseLotRequest) error
	CreateGrantLot(ctx context.Context, req CreateGrantLotRequest) error
	RefundLot(ctx context.Context, req RefundLotRequest) error
	ConsumeFIFO(ctx context.Context, req ConsumeFIFORequest) error
	ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]ExpiredLot, error)
}

// CreatePurchaseLotRequest creates a purchase lot and matching transaction.
type CreatePurchaseLotRequest struct {
	UserID             string
	AmountMillicredits int64
	StripeSessionID    string
	ExpiresAt          *time.Time
	Metadata           billingmodel.JSONMap
}

// CreateGrantLotRequest creates a grant lot and matching transaction.
type CreateGrantLotRequest struct {
	UserID             string
	AmountMillicredits int64
	ExpiresAt          *time.Time
	GrantReason        string
	Metadata           billingmodel.JSONMap
}

// ConsumeFIFORequest consumes credits from lots using FIFO semantics.
type ConsumeFIFORequest struct {
	UserID             string
	AmountMillicredits int64
	ConsumptionGroupID uuid.UUID
	UsageEventID       string
	Metadata           billingmodel.JSONMap
}

// RefundLotRequest removes credits from a purchase lot associated with a Stripe checkout session.
type RefundLotRequest struct {
	StripeSessionID string
	Metadata        billingmodel.JSONMap
}

// ExpiredLot represents one lot that was expired and journaled.
type ExpiredLot struct {
	LotID              uuid.UUID
	UserID             string
	AmountMillicredits int64
}
