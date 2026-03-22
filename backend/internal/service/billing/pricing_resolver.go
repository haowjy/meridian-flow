package billing

import (
	"fmt"
	"log/slog"
	"strings"

	"meridian/internal/capabilities"
	billing "meridian/internal/domain/billing"
)

var _ billing.ModelPricingResolver = (*RegistryPricingResolver)(nil)

// RegistryPricingResolver resolves settlement pricing from capability YAML.
type RegistryPricingResolver struct {
	registry *capabilities.Registry
}

func NewRegistryPricingResolver(registry *capabilities.Registry, _ *slog.Logger) *RegistryPricingResolver {
	return &RegistryPricingResolver{
		registry: registry,
	}
}

func (r *RegistryPricingResolver) ResolvePricing(provider, model string) (billing.ModelPricing, error) {
	if r.registry == nil {
		return billing.FallbackModelPricing, fmt.Errorf("capability registry is required")
	}
	provider = strings.ToLower(strings.TrimSpace(provider))
	if provider == "" {
		return billing.FallbackModelPricing, fmt.Errorf("provider is required")
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return billing.FallbackModelPricing, fmt.Errorf("model is required")
	}

	providerCaps, err := r.registry.GetProviderCapabilities(provider)
	if err != nil {
		return billing.FallbackModelPricing, err
	}

	modelCaps, err := r.registry.GetModelCapabilities(provider, model)
	if err != nil {
		return billing.FallbackModelPricing, err
	}
	if len(modelCaps.PricingTiers) == 0 {
		return billing.FallbackModelPricing, fmt.Errorf("model %q has no pricing tiers", model)
	}

	// Billing currently uses the base tier (threshold: null). Request-level tiering
	// is deferred until we have reliable per-request context-window usage signals.
	var baseTier *capabilities.PricingTier
	for i := range modelCaps.PricingTiers {
		if modelCaps.PricingTiers[i].Threshold == nil {
			baseTier = &modelCaps.PricingTiers[i]
			break
		}
	}
	if baseTier == nil {
		return billing.FallbackModelPricing, fmt.Errorf("model %q has no base pricing tier", model)
	}

	var providerMarkup *int64
	if providerCaps.BillingDefaults != nil {
		providerMarkup = providerCaps.BillingDefaults.MarkupBasisPoints
	}

	pricing, err := billing.ConvertTierToModelPricing(billing.TierPricingInput{
		InputPrice:        baseTier.InputPrice,
		OutputPrice:       baseTier.OutputPrice,
		ReasoningPrice:    baseTier.ReasoningPrice,
		CachedPrice:       baseTier.CachedPrice,
		MarkupBasisPoints: baseTier.MarkupBasisPoints,
	}, providerMarkup)
	if err != nil {
		return billing.FallbackModelPricing, fmt.Errorf("convert pricing tier for %s/%s: %w", provider, model, err)
	}

	return pricing, nil
}
