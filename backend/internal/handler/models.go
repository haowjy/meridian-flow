package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/httputil"
)

// ModelsHandler handles HTTP requests for model capabilities
type ModelsHandler struct {
	config   *config.Config
	logger   *slog.Logger
	registry *capabilities.Registry
}

// NewModelsHandler creates a new models handler
func NewModelsHandler(cfg *config.Config, logger *slog.Logger, registry *capabilities.Registry) *ModelsHandler {
	return &ModelsHandler{
		config:   cfg,
		logger:   logger,
		registry: registry,
	}
}

// ProviderResponse represents a provider with its models
type ProviderResponse struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Models []ModelResponse `json:"models"`
}

// ModelResponse represents a model's capabilities for the API response
type ModelResponse struct {
	ID            string            `json:"id"`
	DisplayName   string            `json:"display_name"`
	ContextWindow int               `json:"context_window"`
	Capabilities  CapabilitiesInfo  `json:"capabilities"`
	Pricing       PricingInfo       `json:"pricing"`
}

// CapabilitiesInfo represents model capabilities
type CapabilitiesInfo struct {
	ToolCalls       string `json:"tool_calls"`        // excellent, good, fair, poor
	ImageInput      bool   `json:"image_input"`       // Vision
	ImageGeneration bool   `json:"image_generation"`
	Streaming       bool   `json:"streaming"`
	Thinking        bool   `json:"thinking"`
}

// PricingInfo represents model pricing
type PricingInfo struct {
	InputPer1M  float64              `json:"input_per_1m"`  // First tier, text modality (backward compat)
	OutputPer1M float64              `json:"output_per_1m"` // First tier, text modality (backward compat)
	Tiers       []PricingTierResponse `json:"tiers"`         // Full tier information
}

// PricingTierResponse represents a single pricing tier
type PricingTierResponse struct {
	Threshold   *int                `json:"threshold"`    // null = unlimited
	InputPrice  map[string]float64  `json:"input_price"`  // modality -> price
	OutputPrice map[string]float64  `json:"output_price"` // modality -> price
}

// GetCapabilities returns model capabilities for all configured providers
func (h *ModelsHandler) GetCapabilities(w http.ResponseWriter, r *http.Request) {
	var providers []ProviderResponse

	// Check Anthropic
	if h.config.AnthropicAPIKey != "" {
		if models, err := h.registry.ListProviderModels("anthropic"); err == nil {
			provider := h.convertProvider("anthropic", "Anthropic", models)
			providers = append(providers, provider)
		}
	}

	// Check OpenRouter
	if h.config.OpenRouterAPIKey != "" {
		if models, err := h.registry.ListProviderModels("openrouter"); err == nil {
			provider := h.convertProvider("openrouter", "OpenRouter", models)
			providers = append(providers, provider)
		}
	}

	response := map[string]interface{}{
		"providers": providers,
	}

	httputil.RespondJSON(w, http.StatusOK, response)
}

// convertProvider converts capability registry data to API response format
func (h *ModelsHandler) convertProvider(id, name string, models map[string]capabilities.ModelCapabilities) ProviderResponse {
	var modelResponses []ModelResponse

	for modelID, modelCap := range models {
		// Convert pricing tiers
		var tiers []PricingTierResponse
		for _, tier := range modelCap.PricingTiers {
			tiers = append(tiers, PricingTierResponse{
				Threshold:   tier.Threshold,
				InputPrice:  tier.InputPrice,
				OutputPrice: tier.OutputPrice,
			})
		}

		// Extract first tier's text price for backward compatibility
		var inputPer1M, outputPer1M float64
		if len(modelCap.PricingTiers) > 0 {
			firstTier := modelCap.PricingTiers[0]
			if textInput, ok := firstTier.InputPrice["text"]; ok {
				inputPer1M = textInput
			}
			if textOutput, ok := firstTier.OutputPrice["text"]; ok {
				outputPer1M = textOutput
			}
		}

		modelResponses = append(modelResponses, ModelResponse{
			ID:            modelID,
			DisplayName:   modelCap.DisplayName,
			ContextWindow: modelCap.ContextWindow,
			Capabilities: CapabilitiesInfo{
				ToolCalls:       string(modelCap.ToolCallQuality),
				ImageInput:      modelCap.SupportsVision,
				ImageGeneration: modelCap.ImageGeneration != capabilities.ImageGenerationNone,
				Streaming:       true, // All providers support streaming
				Thinking:        modelCap.SupportsThinking,
			},
			Pricing: PricingInfo{
				InputPer1M:  inputPer1M,
				OutputPer1M: outputPer1M,
				Tiers:       tiers,
			},
		})
	}

	return ProviderResponse{
		ID:     id,
		Name:   name,
		Models: modelResponses,
	}
}
