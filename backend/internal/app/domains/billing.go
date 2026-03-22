package domains

import (
	"fmt"
	"net/http"
	"strings"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	billing "meridian/internal/domain/billing"
	"meridian/internal/handler"
	postgresBilling "meridian/internal/repository/postgres/billing"
	serviceBilling "meridian/internal/service/billing"
)

// BillingModule wires billing services and handlers.
type BillingModule struct {
	AdmissionChecker       billing.CreditAdmissionChecker
	CreditSettler          billing.CreditSettler
	SettlementMode         billing.CreditSettlementMode
	CreditGranter          billing.CreditGranter
	CreditService          billing.CreditService
	CreditStore            billing.CreditStore
	GenerationBillingStore billing.GenerationBillingStore
	Handler                *handler.BillingHandler
}

// NewBillingModule creates billing repositories/services/handlers.
func NewBillingModule(infra InfrastructureDeps, cfg *config.Config, capabilityRegistry *capabilities.Registry) (*BillingModule, error) {
	creditStore := postgresBilling.NewCreditStore(infra.RepoConfig)
	generationBillingStore := postgresBilling.NewGenerationBillingStore(infra.RepoConfig)

	stripeClient := serviceBilling.NewStripeClient(cfg.Billing.StripeSecretKey, cfg.Billing.StripeWebhookSecret)
	creditService := serviceBilling.NewCreditService(creditStore, stripeClient, infra.Logger)
	creditGranter := serviceBilling.NewCreditGranter(creditStore, infra.Logger)

	admissionChecker := billing.CreditAdmissionChecker(serviceBilling.NewCreditAdmissionChecker(creditStore, infra.Logger))
	settlementMode := billing.CreditSettlementDeferredToEnrichment
	switch strings.ToLower(cfg.LLM.DefaultProvider) {
	case "anthropic":
		settlementMode = billing.CreditSettlementInlineAuthoritative
	case "openrouter", "":
		settlementMode = billing.CreditSettlementDeferredToEnrichment
	default:
		infra.Logger.Warn("unknown default provider; using deferred settlement mode",
			"default_provider", cfg.LLM.DefaultProvider,
		)
	}

	pricingResolver := billing.ModelPricingResolver(serviceBilling.NewRegistryPricingResolver(capabilityRegistry, infra.Logger))
	creditSettler := billing.CreditSettler(serviceBilling.NewCreditSettler(creditStore, generationBillingStore, pricingResolver, infra.Logger))

	if cfg.Billing.StripeSecretKey == "" || cfg.Billing.StripeWebhookSecret == "" {
		if cfg.IsProd() {
			return nil, fmt.Errorf("stripe keys are required in production")
		}
		infra.Logger.Warn("stripe keys are missing; using noop billing collaborators for streaming admission/settlement",
			"environment", cfg.Server.Environment,
			"has_stripe_secret_key", cfg.Billing.StripeSecretKey != "",
			"has_stripe_webhook_secret", cfg.Billing.StripeWebhookSecret != "",
		)
		admissionChecker = serviceBilling.NewNoopCreditAdmissionChecker()
		creditSettler = serviceBilling.NewNoopCreditSettler()
	}

	return &BillingModule{
		AdmissionChecker:       admissionChecker,
		CreditSettler:          creditSettler,
		SettlementMode:         settlementMode,
		CreditGranter:          creditGranter,
		CreditService:          creditService,
		CreditStore:            creditStore,
		GenerationBillingStore: generationBillingStore,
		Handler:                handler.NewBillingHandler(creditService, infra.Logger, cfg),
	}, nil
}

// RegisterRoutes registers billing routes.
func (m *BillingModule) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/billing/packs", m.Handler.GetPacks)
	mux.HandleFunc("GET /api/billing/balance", m.Handler.GetBalance)
	mux.HandleFunc("GET /api/billing/transactions", m.Handler.ListTransactions)
	mux.HandleFunc("POST /api/billing/checkout-sessions", m.Handler.CreateCheckoutSession)
	mux.HandleFunc("POST /api/billing/webhooks/stripe", m.Handler.HandleStripeWebhook)
}
