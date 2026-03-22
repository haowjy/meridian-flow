package billing

import (
	"testing"

	"meridian/internal/capabilities"
	billingmodel "meridian/internal/domain/models/billing"
)

func TestRegistryPricingResolver_ResolvePricing_UsesBaseTierForTieredModel(t *testing.T) {
	resolver := newTestResolver(t)

	pricing, err := resolver.ResolvePricing("openrouter", "x-ai/grok-4.1-fast")
	if err != nil {
		t.Fatalf("ResolvePricing() error = %v", err)
	}

	if pricing.InputMicrousdPer1K != 200 {
		t.Fatalf("InputMicrousdPer1K = %d, want %d", pricing.InputMicrousdPer1K, 200)
	}
	if pricing.OutputMicrousdPer1K != 500 {
		t.Fatalf("OutputMicrousdPer1K = %d, want %d", pricing.OutputMicrousdPer1K, 500)
	}
}

func TestRegistryPricingResolver_ResolvePricing_AllConfiguredModels(t *testing.T) {
	resolver := newTestResolver(t)

	tests := []struct {
		provider string
		model    string
		pricing  billingmodel.ModelPricing
	}{
		{
			provider: "anthropic",
			model:    "claude-haiku-4-5",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     1000,
				OutputMicrousdPer1K:    5000,
				ReasoningMicrousdPer1K: 5000,
				CachedMicrousdPer1K:    500,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "moonshotai/kimi-k2-thinking",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     500,
				OutputMicrousdPer1K:    2500,
				ReasoningMicrousdPer1K: 2500,
				CachedMicrousdPer1K:    250,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "moonshotai/kimi-k2.5",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     600,
				OutputMicrousdPer1K:    3000,
				ReasoningMicrousdPer1K: 3000,
				CachedMicrousdPer1K:    300,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "google/gemini-2.5-flash",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     300,
				OutputMicrousdPer1K:    2500,
				ReasoningMicrousdPer1K: 2500,
				CachedMicrousdPer1K:    150,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "x-ai/grok-4.1-fast",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     200,
				OutputMicrousdPer1K:    500,
				ReasoningMicrousdPer1K: 500,
				CachedMicrousdPer1K:    100,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "deepseek/deepseek-r1-0528",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     200,
				OutputMicrousdPer1K:    4500,
				ReasoningMicrousdPer1K: 4500,
				CachedMicrousdPer1K:    100,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "deepseek/deepseek-chat-v3-0324",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     200,
				OutputMicrousdPer1K:    900,
				ReasoningMicrousdPer1K: 900,
				CachedMicrousdPer1K:    100,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "qwen/qwen3-vl-235b-a22b-instruct",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     300,
				OutputMicrousdPer1K:    1200,
				ReasoningMicrousdPer1K: 1200,
				CachedMicrousdPer1K:    150,
				MarkupBasisPoints:      1500,
			},
		},
		{
			provider: "openrouter",
			model:    "prime-intellect/intellect-3",
			pricing: billingmodel.ModelPricing{
				InputMicrousdPer1K:     200,
				OutputMicrousdPer1K:    1100,
				ReasoningMicrousdPer1K: 1100,
				CachedMicrousdPer1K:    100,
				MarkupBasisPoints:      1500,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.provider+"/"+tc.model, func(t *testing.T) {
			got, err := resolver.ResolvePricing(tc.provider, tc.model)
			if err != nil {
				t.Fatalf("ResolvePricing() error = %v", err)
			}
			if got != tc.pricing {
				t.Fatalf("pricing mismatch for %s/%s:\n got:  %+v\n want: %+v", tc.provider, tc.model, got, tc.pricing)
			}
		})
	}
}

func TestRegistryPricingResolver_ResolvePricing_OpenRouterVariantModelID(t *testing.T) {
	resolver := newTestResolver(t)

	pricing, err := resolver.ResolvePricing("openrouter", "google/gemini-2.5-flash-2025-08-07")
	if err != nil {
		t.Fatalf("ResolvePricing() error = %v", err)
	}

	if pricing.InputMicrousdPer1K != 300 || pricing.OutputMicrousdPer1K != 2500 {
		t.Fatalf("variant pricing = %+v, want input=300 output=2500", pricing)
	}
}

func TestRegistryPricingResolver_ResolvePricing_UnknownModelReturnsFallbackAndError(t *testing.T) {
	resolver := newTestResolver(t)

	got, err := resolver.ResolvePricing("openrouter", "unknown/model")
	if err == nil {
		t.Fatalf("expected error for unknown model")
	}
	if got != billingmodel.FallbackModelPricing {
		t.Fatalf("fallback mismatch:\n got:  %+v\n want: %+v", got, billingmodel.FallbackModelPricing)
	}
}

func newTestResolver(t *testing.T) *RegistryPricingResolver {
	t.Helper()

	registry, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}

	return NewRegistryPricingResolver(registry, nil)
}
