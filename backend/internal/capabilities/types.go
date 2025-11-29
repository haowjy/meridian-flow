package capabilities

import "gopkg.in/yaml.v3"

// ToolCallQuality represents how well a model handles function calling
type ToolCallQuality string

const (
	ToolCallQualityExcellent ToolCallQuality = "excellent"
	ToolCallQualityGood      ToolCallQuality = "good"
	ToolCallQualityBasic     ToolCallQuality = "basic"
)

// ImageGeneration represents image generation capabilities
type ImageGeneration string

const (
	ImageGenerationNone     ImageGeneration = "none"
	ImageGenerationStandard ImageGeneration = "standard"
	ImageGenerationHD       ImageGeneration = "hd"
)

// PricingTier represents a pricing tier based on context window usage
type PricingTier struct {
	Threshold   *int               `yaml:"threshold" json:"threshold"`       // null = unlimited
	InputPrice  map[string]float64 `yaml:"input_price" json:"input_price"`   // modality -> price (e.g., "text": 5.00, "audio": 15.00)
	OutputPrice map[string]float64 `yaml:"output_price" json:"output_price"` // modality -> price (e.g., "text": 15.00, "image": 20.00)
}

// ModelCapabilities represents all metadata for a specific model
type ModelCapabilities struct {
	// Model identifier (set during YAML unmarshaling)
	ID string `yaml:"-" json:"id"`

	// Display information
	DisplayName string `yaml:"display_name" json:"display_name"`
	Description string `yaml:"description" json:"description"`

	// Core capabilities
	SupportsTools    bool `yaml:"supports_tools" json:"supports_tools"`
	SupportsThinking bool `yaml:"supports_thinking" json:"supports_thinking"`
	SupportsVision   bool `yaml:"supports_vision" json:"supports_vision"`

	// RequiresThinking means this model cannot have thinking disabled
	// True for thinking-variant models like kimi-k2-thinking
	RequiresThinking bool `yaml:"requires_thinking" json:"requires_thinking"`

	// Advanced capabilities
	ToolCallQuality ToolCallQuality `yaml:"tool_call_quality" json:"tool_call_quality"`
	ImageGeneration ImageGeneration `yaml:"image_generation" json:"image_generation"`

	// Limits
	ContextWindow int `yaml:"context_window" json:"context_window"`
	MaxOutput     int `yaml:"max_output" json:"max_output"`

	// Pricing (per million tokens, supports tiers and modalities)
	PricingTiers []PricingTier `yaml:"pricing_tiers" json:"pricing_tiers"`
}

// ProviderCapabilities represents all models for a provider
type ProviderCapabilities struct {
	Provider string              `yaml:"provider" json:"provider"`
	Models   []ModelCapabilities `yaml:"-" json:"models"` // Ordered slice, populated by custom unmarshaler
}

// UnmarshalYAML implements custom YAML unmarshaling to preserve model order from YAML file
func (p *ProviderCapabilities) UnmarshalYAML(node *yaml.Node) error {
	// First, decode the provider field
	for i := 0; i < len(node.Content); i += 2 {
		if node.Content[i].Value == "provider" {
			p.Provider = node.Content[i+1].Value
			break
		}
	}

	// Decode models into a map first to get the full data
	type modelsOnly struct {
		Models map[string]ModelCapabilities `yaml:"models"`
	}
	var m modelsOnly
	if err := node.Decode(&m); err != nil {
		return err
	}

	// Now extract model keys in YAML order and build the slice
	for i := 0; i < len(node.Content); i += 2 {
		if node.Content[i].Value == "models" {
			modelsNode := node.Content[i+1]
			// modelsNode.Content alternates: key, value, key, value...
			for j := 0; j < len(modelsNode.Content); j += 2 {
				modelID := modelsNode.Content[j].Value
				if model, ok := m.Models[modelID]; ok {
					model.ID = modelID
					p.Models = append(p.Models, model)
				}
			}
			break
		}
	}

	return nil
}
