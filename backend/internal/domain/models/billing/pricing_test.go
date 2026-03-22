package billing

import "testing"

func TestCeilDiv(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name        string
		numerator   int64
		denominator int64
		want        int64
	}{
		{name: "exact division", numerator: 100, denominator: 10, want: 10},
		{name: "remainder rounds up", numerator: 101, denominator: 10, want: 11},
		{name: "zero numerator", numerator: 0, denominator: 10, want: 0},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got := ceilDiv(tc.numerator, tc.denominator)
			if got != tc.want {
				t.Fatalf("ceilDiv(%d, %d) = %d, want %d", tc.numerator, tc.denominator, got, tc.want)
			}
		})
	}
}

func TestConvertTierToModelPricing_Rounding(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name string
		usd  float64
		want int64
	}{
		{name: "0.20", usd: 0.20, want: 200},
		{name: "0.30", usd: 0.30, want: 300},
		{name: "0.50", usd: 0.50, want: 500},
		{name: "2.50", usd: 2.50, want: 2500},
		{name: "4.50", usd: 4.50, want: 4500},
		{name: "15.00", usd: 15.00, want: 15000},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			pricing, err := ConvertTierToModelPricing(TierPricingInput{
				InputPrice:  map[string]float64{"text": tc.usd},
				OutputPrice: map[string]float64{"text": tc.usd},
			}, nil)
			if err != nil {
				t.Fatalf("ConvertTierToModelPricing() error = %v", err)
			}

			if pricing.InputMicrousdPer1K != tc.want {
				t.Fatalf("InputMicrousdPer1K = %d, want %d", pricing.InputMicrousdPer1K, tc.want)
			}
			if pricing.OutputMicrousdPer1K != tc.want {
				t.Fatalf("OutputMicrousdPer1K = %d, want %d", pricing.OutputMicrousdPer1K, tc.want)
			}
		})
	}
}

func TestConvertTierToModelPricing_Defaults(t *testing.T) {
	t.Parallel()

	providerMarkup := int64(2200)
	pricing, err := ConvertTierToModelPricing(TierPricingInput{
		InputPrice:  map[string]float64{"text": 3.00},
		OutputPrice: map[string]float64{"text": 15.00},
	}, &providerMarkup)
	if err != nil {
		t.Fatalf("ConvertTierToModelPricing() error = %v", err)
	}

	if pricing.InputMicrousdPer1K != 3000 {
		t.Fatalf("InputMicrousdPer1K = %d, want %d", pricing.InputMicrousdPer1K, 3000)
	}
	if pricing.OutputMicrousdPer1K != 15000 {
		t.Fatalf("OutputMicrousdPer1K = %d, want %d", pricing.OutputMicrousdPer1K, 15000)
	}
	if pricing.ReasoningMicrousdPer1K != 15000 {
		t.Fatalf("ReasoningMicrousdPer1K = %d, want %d", pricing.ReasoningMicrousdPer1K, 15000)
	}
	if pricing.CachedMicrousdPer1K != 1500 {
		t.Fatalf("CachedMicrousdPer1K = %d, want %d", pricing.CachedMicrousdPer1K, 1500)
	}
	if pricing.MarkupBasisPoints != providerMarkup {
		t.Fatalf("MarkupBasisPoints = %d, want %d", pricing.MarkupBasisPoints, providerMarkup)
	}
}

func TestConvertTierToModelPricing_TierMarkupOverride(t *testing.T) {
	t.Parallel()

	providerMarkup := int64(2200)
	tierMarkup := int64(900)
	pricing, err := ConvertTierToModelPricing(TierPricingInput{
		InputPrice:        map[string]float64{"text": 1.00},
		OutputPrice:       map[string]float64{"text": 5.00},
		ReasoningPrice:    map[string]float64{"text": 4.00},
		CachedPrice:       map[string]float64{"text": 0.40},
		MarkupBasisPoints: &tierMarkup,
	}, &providerMarkup)
	if err != nil {
		t.Fatalf("ConvertTierToModelPricing() error = %v", err)
	}

	if pricing.ReasoningMicrousdPer1K != 4000 {
		t.Fatalf("ReasoningMicrousdPer1K = %d, want %d", pricing.ReasoningMicrousdPer1K, 4000)
	}
	if pricing.CachedMicrousdPer1K != 400 {
		t.Fatalf("CachedMicrousdPer1K = %d, want %d", pricing.CachedMicrousdPer1K, 400)
	}
	if pricing.MarkupBasisPoints != tierMarkup {
		t.Fatalf("MarkupBasisPoints = %d, want %d", pricing.MarkupBasisPoints, tierMarkup)
	}
}

func TestConvertTierToModelPricing_MissingTextPrices(t *testing.T) {
	t.Parallel()

	_, err := ConvertTierToModelPricing(TierPricingInput{OutputPrice: map[string]float64{"text": 1.0}}, nil)
	if err == nil {
		t.Fatalf("expected missing input text price error")
	}

	_, err = ConvertTierToModelPricing(TierPricingInput{InputPrice: map[string]float64{"text": 1.0}}, nil)
	if err == nil {
		t.Fatalf("expected missing output text price error")
	}
}

func TestCalculateCreditCostMinimumOneMillicredit(t *testing.T) {
	t.Parallel()

	if got := CalculateCreditCost(ModelPricing{}, TokenUsage{}); got != 1 {
		t.Fatalf("CalculateCreditCost({}, {}) = %d, want 1", got)
	}

	pricing := ModelPricing{
		InputMicrousdPer1K:     1,
		OutputMicrousdPer1K:    1,
		ReasoningMicrousdPer1K: 1,
		CachedMicrousdPer1K:    1,
		MarkupBasisPoints:      0,
	}
	usage := TokenUsage{InputTokens: 1}

	if got := CalculateCreditCost(pricing, usage); got != 1 {
		t.Fatalf("CalculateCreditCost(pricing, usage) = %d, want 1", got)
	}
}

func TestFallbackModelPricing_IsConservative(t *testing.T) {
	t.Parallel()

	if FallbackModelPricing.InputMicrousdPer1K < 1000 {
		t.Fatalf("fallback input pricing should not undercut standard low-cost models")
	}
	if FallbackModelPricing.OutputMicrousdPer1K < 5000 {
		t.Fatalf("fallback output pricing should not undercut standard low-cost models")
	}
	if FallbackModelPricing.MarkupBasisPoints <= 0 {
		t.Fatalf("fallback markup must be positive")
	}
}
