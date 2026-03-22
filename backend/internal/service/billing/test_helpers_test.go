package billing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	billing "meridian/internal/domain/billing"
)

type mockCreditStore struct {
	balance    *billing.CreditBalance
	balanceErr error

	transactionsPage *billing.CreditTransactionPage
	transactionsErr  error

	createPurchaseErr error
	createGrantErr    error
	refundErr         error
	consumeErr        error
	expireLots        []billing.ExpiredLot
	expireErr         error

	lastCreateGrantReq    billing.CreateGrantLotRequest
	lastCreatePurchaseReq billing.CreatePurchaseLotRequest
	lastRefundReq         billing.RefundLotRequest
	consumeCalls          []billing.ConsumeFIFORequest

	callOrder *[]string
}

func (m *mockCreditStore) GetBalance(ctx context.Context, userID string) (*billing.CreditBalance, error) {
	_ = ctx
	_ = userID
	if m.balanceErr != nil {
		return nil, m.balanceErr
	}
	if m.balance == nil {
		return &billing.CreditBalance{}, nil
	}
	return m.balance, nil
}

func (m *mockCreditStore) ListTransactions(ctx context.Context, userID string, req billing.ListTransactionsRequest) (*billing.CreditTransactionPage, error) {
	_ = ctx
	_ = userID
	_ = req
	if m.transactionsErr != nil {
		return nil, m.transactionsErr
	}
	if m.transactionsPage == nil {
		return &billing.CreditTransactionPage{}, nil
	}
	return m.transactionsPage, nil
}

func (m *mockCreditStore) CreatePurchaseLot(ctx context.Context, req billing.CreatePurchaseLotRequest) error {
	_ = ctx
	m.lastCreatePurchaseReq = req
	return m.createPurchaseErr
}

func (m *mockCreditStore) CreateGrantLot(ctx context.Context, req billing.CreateGrantLotRequest) error {
	_ = ctx
	m.lastCreateGrantReq = req
	return m.createGrantErr
}

func (m *mockCreditStore) RefundLot(ctx context.Context, req billing.RefundLotRequest) error {
	_ = ctx
	m.lastRefundReq = req
	return m.refundErr
}

func (m *mockCreditStore) ConsumeFIFO(ctx context.Context, req billing.ConsumeFIFORequest) error {
	_ = ctx
	m.consumeCalls = append(m.consumeCalls, req)
	if m.callOrder != nil {
		*m.callOrder = append(*m.callOrder, "consume")
	}
	return m.consumeErr
}

func (m *mockCreditStore) ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]billing.ExpiredLot, error) {
	_ = ctx
	_ = nowUTC
	_ = batchSize
	if m.expireErr != nil {
		return nil, m.expireErr
	}
	return m.expireLots, nil
}

type markStatusCall struct {
	TurnID       string
	RequestIndex int
	Status       string
	LastError    string
}

type mockGenerationBillingStore struct {
	setErr  error
	getErr  error
	markErr error

	fields *billing.BillingFields

	setCalls  []billing.BillingFields
	markCalls []markStatusCall

	callOrder *[]string
}

func (m *mockGenerationBillingStore) SetBillingFields(ctx context.Context, turnID string, requestIndex int, fields billing.BillingFields) error {
	_ = ctx
	_ = turnID
	_ = requestIndex
	m.setCalls = append(m.setCalls, fields)
	if m.callOrder != nil {
		*m.callOrder = append(*m.callOrder, "set")
	}
	if m.setErr != nil {
		return m.setErr
	}
	copied := fields
	m.fields = &copied
	return nil
}

func (m *mockGenerationBillingStore) GetBillingFields(ctx context.Context, turnID string, requestIndex int) (*billing.BillingFields, error) {
	_ = ctx
	_ = turnID
	_ = requestIndex
	if m.getErr != nil {
		return nil, m.getErr
	}
	if m.fields == nil {
		return nil, nil
	}
	copied := *m.fields
	return &copied, nil
}

func (m *mockGenerationBillingStore) MarkBillingStatus(ctx context.Context, turnID string, requestIndex int, status string, lastError string) error {
	_ = ctx
	m.markCalls = append(m.markCalls, markStatusCall{
		TurnID:       turnID,
		RequestIndex: requestIndex,
		Status:       status,
		LastError:    lastError,
	})
	if m.callOrder != nil {
		*m.callOrder = append(*m.callOrder, "mark")
	}
	if m.markErr != nil {
		return m.markErr
	}
	if m.fields != nil {
		m.fields.Status = status
		m.fields.LastError = lastError
		if status == billingStatusPending || status == billingStatusFailed {
			m.fields.RetryCount++
		}
	}
	return nil
}

func (m *mockGenerationBillingStore) ListPendingSettlements(ctx context.Context, olderThan time.Time, limit int) ([]billing.PendingSettlement, error) {
	_ = ctx
	_ = olderThan
	_ = limit
	if m.fields == nil {
		return []billing.PendingSettlement{}, nil
	}
	return []billing.PendingSettlement{
		{TurnID: "turn-1", RequestIndex: 0, Billing: *m.fields},
	}, nil
}

func mustConsumptionGroup(usageEventID string) uuid.UUID {
	return uuid.NewSHA1(billing.BillingNamespace, []byte(usageEventID))
}

func isInsufficientCreditsError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "insufficient credits")
}

func duplicateGrantErr() error {
	return errors.New("duplicate key value violates unique constraint grant_reason")
}

type mockPricingResolver struct {
	pricingByProviderModel map[string]billing.ModelPricing
	errByProviderModel     map[string]error
}

var _ billing.ModelPricingResolver = (*mockPricingResolver)(nil)

func (m *mockPricingResolver) ResolvePricing(provider, model string) (billing.ModelPricing, error) {
	key := fmt.Sprintf("%s:%s", provider, model)
	if err, ok := m.errByProviderModel[key]; ok {
		return billing.FallbackModelPricing, err
	}
	if pricing, ok := m.pricingByProviderModel[key]; ok {
		return pricing, nil
	}
	return billing.FallbackModelPricing, fmt.Errorf("missing pricing for %s", key)
}
