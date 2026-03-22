package billing

import (
	"fmt"
	"math"

	"github.com/google/uuid"
)

const (
	// Monthly free credits — granted on login, same for all users (no separate signup bonus).
	MonthlyRefreshMillicredits   int64 = 100_000 // 100 credits/month
	MonthlyRefreshExpirationDays       = 60      // free credits expire after 60 days

	// Paid credit expiration — purchased packs last 12 months.
	PurchasedCreditExpirationDays = 365

	// DefaultMarkupBasisPoints is used when no provider/model override is configured.
	DefaultMarkupBasisPoints int64 = 1500
)

// BillingNamespace is the stable UUID v5 namespace for deriving consumption_group_id values.
// It must never change — changing it breaks idempotency for in-flight pending settlements.
var BillingNamespace = uuid.MustParse("c3271962-2530-437e-89a4-b5e034becf7e")

// CreditPacks is the launch catalog for Stripe checkout packs.
var CreditPacks = []CreditPack{
	{
		PackID:       "starter",
		Label:        "Starter",
		PriceCents:   1000,
		Credits:      1000,
		BonusCredits: 0,
	},
	{
		PackID:       "writer",
		Label:        "Writer",
		PriceCents:   2500,
		Credits:      2800,
		BonusCredits: 300,
	},
	{
		PackID:       "novelist",
		Label:        "Novelist",
		PriceCents:   5000,
		Credits:      6000,
		BonusCredits: 1000,
	},
}

// FallbackModelPricing is used when capability pricing resolution fails.
// Values are intentionally conservative (premium-tier) to avoid under-
var FallbackModelPricing = ModelPricing{
	InputMicrousdPer1K:     15000,
	OutputMicrousdPer1K:    75000,
	ReasoningMicrousdPer1K: 75000,
	CachedMicrousdPer1K:    7500,
	MarkupBasisPoints:      DefaultMarkupBasisPoints,
}

// TierPricingInput is a domain-friendly representation of one pricing tier loaded from config.
// Prices are expressed as USD per 1M tokens.
type TierPricingInput struct {
	InputPrice        map[string]float64
	OutputPrice       map[string]float64
	ReasoningPrice    map[string]float64
	CachedPrice       map[string]float64
	MarkupBasisPoints *int64
}

// ConvertTierToModelPricing converts one text pricing tier into settlement pricing.
// Conversion rule: microusd_per_1k = round(usd_per_1m * 1000).
func ConvertTierToModelPricing(tier TierPricingInput, providerMarkupBasisPoints *int64) (ModelPricing, error) {
	inputUSD, ok := tier.InputPrice["text"]
	if !ok {
		return ModelPricing{}, fmt.Errorf("missing text input price")
	}
	outputUSD, ok := tier.OutputPrice["text"]
	if !ok {
		return ModelPricing{}, fmt.Errorf("missing text output price")
	}

	input := usdPer1MToMicrousdPer1K(inputUSD)
	output := usdPer1MToMicrousdPer1K(outputUSD)

	reasoning := output
	if v, ok := tier.ReasoningPrice["text"]; ok {
		reasoning = usdPer1MToMicrousdPer1K(v)
	}

	cached := usdPer1MToMicrousdPer1K(inputUSD * 0.5)
	if v, ok := tier.CachedPrice["text"]; ok {
		cached = usdPer1MToMicrousdPer1K(v)
	}

	markup := DefaultMarkupBasisPoints
	if providerMarkupBasisPoints != nil {
		markup = *providerMarkupBasisPoints
	}
	if tier.MarkupBasisPoints != nil {
		markup = *tier.MarkupBasisPoints
	}

	return ModelPricing{
		InputMicrousdPer1K:     input,
		OutputMicrousdPer1K:    output,
		ReasoningMicrousdPer1K: reasoning,
		CachedMicrousdPer1K:    cached,
		MarkupBasisPoints:      markup,
	}, nil
}

// CalculateCreditCost computes authoritative settlement cost using integer-only math.
func CalculateCreditCost(pricing ModelPricing, usage TokenUsage) int64 {
	rawMicrousd :=
		ceilDiv(usage.InputTokens*pricing.InputMicrousdPer1K, 1000) +
			ceilDiv(usage.OutputTokens*pricing.OutputMicrousdPer1K, 1000) +
			ceilDiv(usage.ReasoningTokens*pricing.ReasoningMicrousdPer1K, 1000) +
			ceilDiv(usage.CachedTokens*pricing.CachedMicrousdPer1K, 1000)

	markedMicrousd := ceilDiv(rawMicrousd*(10_000+pricing.MarkupBasisPoints), 10_000)

	// 1 millicredit = 10 microusd because:
	// 1 credit = $0.01 = 10_000 microusd = 1_000 millicredits.
	millicredits := ceilDiv(markedMicrousd, 10)
	if millicredits < 1 {
		return 1
	}

	return millicredits
}

func ceilDiv(numerator, denominator int64) int64 {
	return (numerator + denominator - 1) / denominator
}

func usdPer1MToMicrousdPer1K(price float64) int64 {
	return int64(math.Round(price * 1000))
}
