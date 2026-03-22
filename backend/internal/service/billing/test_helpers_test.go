package billing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	billingmodel "meridian/internal/domain/models/billing"
	billingrepo "meridian/internal/domain/repositories/billing"
	billingdomain "meridian/internal/domain/services/billing"
)

type mockCreditStore struct {
	balance    *billingmodel.CreditBalance
	balanceErr error

	transactionsPage *billingmodel.CreditTransactionPage
	transactionsErr  error

	createPurchaseErr error
	createGrantErr    error
	refundErr         error
	consumeErr        error
	expireLots        []billingrepo.ExpiredLot
	expireErr         error

	lastCreateGrantReq    billingrepo.CreateGrantLotRequest
	lastCreatePurchaseReq billingrepo.CreatePurchaseLotRequest
	lastRefundReq         billingrepo.RefundLotRequest
	consumeCalls          []billingrepo.ConsumeFIFORequest

	callOrder *[]string
}

func (m *mockCreditStore) GetBalance(ctx context.Context, userID string) (*billingmodel.CreditBalance, error) {
	_ = ctx
	_ = userID
	if m.balanceErr != nil {
		return nil, m.balanceErr
	}
	if m.balance == nil {
		return &billingmodel.CreditBalance{}, nil
	}
	return m.balance, nil
}

func (m *mockCreditStore) ListTransactions(ctx context.Context, userID string, req billingmodel.ListTransactionsRequest) (*billingmodel.CreditTransactionPage, error) {
	_ = ctx
	_ = userID
	_ = req
	if m.transactionsErr != nil {
		return nil, m.transactionsErr
	}
	if m.transactionsPage == nil {
		return &billingmodel.CreditTransactionPage{}, nil
	}
	return m.transactionsPage, nil
}

func (m *mockCreditStore) CreatePurchaseLot(ctx context.Context, req billingrepo.CreatePurchaseLotRequest) error {
	_ = ctx
	m.lastCreatePurchaseReq = req
	return m.createPurchaseErr
}

func (m *mockCreditStore) CreateGrantLot(ctx context.Context, req billingrepo.CreateGrantLotRequest) error {
	_ = ctx
	m.lastCreateGrantReq = req
	return m.createGrantErr
}

func (m *mockCreditStore) RefundLot(ctx context.Context, req billingrepo.RefundLotRequest) error {
	_ = ctx
	m.lastRefundReq = req
	return m.refundErr
}

func (m *mockCreditStore) ConsumeFIFO(ctx context.Context, req billingrepo.ConsumeFIFORequest) error {
	_ = ctx
	m.consumeCalls = append(m.consumeCalls, req)
	if m.callOrder != nil {
		*m.callOrder = append(*m.callOrder, "consume")
	}
	return m.consumeErr
}

func (m *mockCreditStore) ExpireAvailableLots(ctx context.Context, nowUTC string, batchSize int) ([]billingrepo.ExpiredLot, error) {
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

	fields *billingrepo.BillingFields

	setCalls  []billingrepo.BillingFields
	markCalls []markStatusCall

	callOrder *[]string
}

func (m *mockGenerationBillingStore) SetBillingFields(ctx context.Context, turnID string, requestIndex int, fields billingrepo.BillingFields) error {
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

func (m *mockGenerationBillingStore) GetBillingFields(ctx context.Context, turnID string, requestIndex int) (*billingrepo.BillingFields, error) {
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

func (m *mockGenerationBillingStore) ListPendingSettlements(ctx context.Context, olderThan time.Time, limit int) ([]billingrepo.PendingSettlement, error) {
	_ = ctx
	_ = olderThan
	_ = limit
	if m.fields == nil {
		return []billingrepo.PendingSettlement{}, nil
	}
	return []billingrepo.PendingSettlement{
		{TurnID: "turn-1", RequestIndex: 0, Billing: *m.fields},
	}, nil
}

func mustConsumptionGroup(usageEventID string) uuid.UUID {
	return uuid.NewSHA1(billingmodel.BillingNamespace, []byte(usageEventID))
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
	pricingByProviderModel map[string]billingmodel.ModelPricing
	errByProviderModel     map[string]error
}

var _ billingdomain.ModelPricingResolver = (*mockPricingResolver)(nil)

func (m *mockPricingResolver) ResolvePricing(provider, model string) (billingmodel.ModelPricing, error) {
	key := fmt.Sprintf("%s:%s", provider, model)
	if err, ok := m.errByProviderModel[key]; ok {
		return billingmodel.FallbackModelPricing, err
	}
	if pricing, ok := m.pricingByProviderModel[key]; ok {
		return pricing, nil
	}
	return billingmodel.FallbackModelPricing, fmt.Errorf("missing pricing for %s", key)
}
