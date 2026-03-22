package handler

import (
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"

	"meridian/internal/config"
	billingmodel "meridian/internal/domain/models/billing"
	billingdomain "meridian/internal/domain/services/billing"
	"meridian/internal/httputil"
)

const (
	defaultTransactionsLimit = 50
	maxTransactionsLimit     = 100
)

// BillingHandler handles billing HTTP requests.
type BillingHandler struct {
	creditService billingdomain.CreditService
	logger        *slog.Logger
	cfg           *config.Config
}

func NewBillingHandler(
	creditService billingdomain.CreditService,
	logger *slog.Logger,
	cfg *config.Config,
) *BillingHandler {
	if logger == nil {
		logger = slog.Default()
	}

	return &BillingHandler{
		creditService: creditService,
		logger:        logger,
		cfg:           cfg,
	}
}

// GetPacks returns the server-authoritative credit pack catalog.
// GET /api/billing/packs
func (h *BillingHandler) GetPacks(w http.ResponseWriter, r *http.Request) {
	packs, err := h.creditService.ListCreditPacks(r.Context())
	if err != nil {
		handleError(w, err, h.cfg)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"packs": packs,
	})
}

// GetBalance returns the authenticated user's credit balance.
// GET /api/billing/balance
func (h *BillingHandler) GetBalance(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)

	balance, err := h.creditService.GetBalance(r.Context(), userID)
	if err != nil {
		handleError(w, err, h.cfg)
		return
	}
	if balance == nil {
		balance = &billingmodel.CreditBalance{}
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"total_balance_millicredits":       balance.TotalBalanceMillicredits,
		"promotional_balance_millicredits": balance.PromotionalBalanceMillicredits,
		"purchased_balance_millicredits":   balance.PurchasedBalanceMillicredits,
		"debt_balance_millicredits":        balance.DebtBalanceMillicredits,
		"display_total_credits":            formatCreditsForDisplay(balance.TotalBalanceMillicredits),
	})
}

// ListTransactions returns paginated billing transaction history.
// GET /api/billing/transactions?limit=50&offset=0
func (h *BillingHandler) ListTransactions(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)

	req := billingmodel.ListTransactionsRequest{
		Limit:  QueryInt(r, "limit", defaultTransactionsLimit, 1, maxTransactionsLimit),
		Offset: QueryInt(r, "offset", 0, 0, math.MaxInt32),
	}

	page, err := h.creditService.ListTransactions(r.Context(), userID, req)
	if err != nil {
		handleError(w, err, h.cfg)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, page)
}

// CreateCheckoutSession starts a Stripe checkout session for a credit pack.
// POST /api/billing/checkout-sessions
func (h *BillingHandler) CreateCheckoutSession(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)

	var req billingdomain.CreateCheckoutSessionRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	session, err := h.creditService.CreateCheckoutSession(r.Context(), userID, req)
	if err != nil {
		handleError(w, err, h.cfg)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, session)
}

// HandleStripeWebhook receives Stripe webhook events.
// POST /api/billing/webhooks/stripe
func (h *BillingHandler) HandleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	// Limit body size on this unauthenticated endpoint to prevent OOM.
	// Stripe payloads are a few KB; 512 KB is generous.
	r.Body = http.MaxBytesReader(w, r.Body, 512<<10)
	payload, err := io.ReadAll(r.Body)
	if err != nil {
		h.logger.Warn("failed to read stripe webhook body", "error", err)
		httputil.RespondError(w, http.StatusBadRequest, "invalid webhook payload")
		return
	}

	req := billingdomain.StripeWebhookRequest{
		Payload:   payload,
		Signature: r.Header.Get("Stripe-Signature"),
	}

	if err := h.creditService.HandleStripeWebhook(r.Context(), req); err != nil {
		handleError(w, err, h.cfg)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{"received": true})
}

func formatCreditsForDisplay(totalMillicredits int64) string {
	credits := float64(totalMillicredits) / 1000.0
	return fmt.Sprintf("%.1f", credits)
}
