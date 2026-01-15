package adapters

import (
	"context"
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
	"github.com/haowjy/meridian-llm-go/providers/openrouter"

	domainllm "meridian/internal/domain/services/llm"
)

// OpenRouterAdapter wraps the library's OpenRouter provider and implements the backend's LLMProvider interface.
// It handles conversion between backend types (with DB fields) and library types (content-only).
type OpenRouterAdapter struct {
	provider llmprovider.Provider
}

// NewOpenRouterAdapter creates a new OpenRouter adapter using the library's provider.
// DEPRECATED: Use NewOpenRouterAdapterWithProvider for factory-based creation
func NewOpenRouterAdapter(apiKey string) (*OpenRouterAdapter, error) {
	provider, err := openrouter.NewProvider(apiKey)
	if err != nil {
		return nil, err
	}

	return &OpenRouterAdapter{
		provider: provider,
	}, nil
}

// NewOpenRouterAdapterWithProvider creates a new OpenRouter adapter from an existing provider.
// Used by provider factory for dynamic provider creation.
func NewOpenRouterAdapterWithProvider(provider llmprovider.Provider) *OpenRouterAdapter {
	return &OpenRouterAdapter{
		provider: provider,
	}
}

// Name returns the provider name.
func (a *OpenRouterAdapter) Name() string {
	return a.provider.Name().String()
}

// SupportsModel returns true if this provider supports the given model.
func (a *OpenRouterAdapter) SupportsModel(model string) bool {
	return a.provider.SupportsModel(model)
}

// GenerateResponse generates a response from OpenRouter.
func (a *OpenRouterAdapter) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
	// Convert backend request to library request
	libReq, err := ConvertToLibraryRequest(req)
	if err != nil {
		return nil, err
	}

	// Call library provider
	libResp, err := a.provider.GenerateResponse(ctx, libReq)
	if err != nil {
		return nil, err
	}

	// Convert library response to backend response
	return convertFromLibraryResponse(libResp), nil
}

// StreamResponse generates a streaming response from OpenRouter.
func (a *OpenRouterAdapter) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Convert backend request to library request
	libReq, err := ConvertToLibraryRequest(req)
	if err != nil {
		return nil, err
	}

	// Call library provider
	libEventCh, err := a.provider.StreamResponse(ctx, libReq)
	if err != nil {
		return nil, err
	}

	// Create backend event channel
	backendEventCh := make(chan domainllm.StreamEvent)

	// Convert library events to backend events
	go func() {
		defer close(backendEventCh)
		for libEvent := range libEventCh {
			backendEventCh <- convertFromLibraryEvent(libEvent)
		}
	}()

	return backendEventCh, nil
}

// BuildDebugProviderRequest builds the OpenRouter provider request payload for debugging.
// It converts the backend GenerateRequest to the library format and then to
// OpenRouter ChatCompletionRequest JSON using the meridian-llm-go helper.
func (a *OpenRouterAdapter) BuildDebugProviderRequest(ctx context.Context, req *domainllm.GenerateRequest) (map[string]interface{}, error) {
	// Convert backend request to library request
	libReq, err := ConvertToLibraryRequest(req)
	if err != nil {
		return nil, err
	}

	// Cast provider to OpenRouter-specific type to access debug method
	openrouterProvider, ok := a.provider.(*openrouter.Provider)
	if !ok {
		return nil, fmt.Errorf("provider is not an OpenRouter provider")
	}

	// Build provider-specific params JSON using library helper method
	return openrouterProvider.BuildChatCompletionRequestDebug(libReq)
}

// QueryGenerationStats implements GenerationStatsQuerier interface.
// Queries OpenRouter's /generation API and converts library type to domain type.
// This allows StreamExecutor to query generation stats without depending on concrete types (DIP compliance).
func (a *OpenRouterAdapter) QueryGenerationStats(ctx context.Context, generationID string) (*domainllm.GenerationStats, error) {
	// Type assert to OpenRouter provider
	// This assertion stays in the adapter layer where it belongs
	orProvider, ok := a.provider.(*openrouter.Provider)
	if !ok {
		return nil, fmt.Errorf("provider is not OpenRouter provider")
	}

	// Query library provider
	libStats, err := orProvider.GetGenerationStats(ctx, generationID)
	if err != nil {
		return nil, err
	}

	// Convert library type (openrouter.GenerationStats) to domain type (domainllm.GenerationStats)
	// This decouples high-level code from library-specific types
	return &domainllm.GenerationStats{
		ID:                     libStats.ID,
		Model:                  libStats.Model,
		ProviderName:           libStats.ProviderName,
		NativeTokensPrompt:     libStats.NativeTokensPrompt,
		NativeTokensCompletion: libStats.NativeTokensCompletion,
		NativeTokensReasoning:  libStats.NativeTokensReasoning,
		NativeTokensCached:     libStats.NativeTokensCached,
		TotalCost:              libStats.TotalCost,
		FinishReason:           libStats.FinishReason,
		CreatedAt:              libStats.CreatedAt,
		UpstreamID:             libStats.UpstreamID,
		Latency:                libStats.Latency,
		Cancelled:              libStats.Cancelled,
		AdditionalFields:       libStats.AdditionalFields,
	}, nil
}

// CancelGeneration implements GenerationCanceller interface.
// Attempts to cancel an ongoing OpenRouter generation via API.
// This allows StreamExecutor to cancel generations without depending on concrete types (DIP compliance).
//
// Note: Success depends on whether the upstream provider supports cancellation.
// - If upstream supports cancel: billing stops immediately
// - If upstream doesn't support cancel: returns error, billing continues
//
// The caller should ALWAYS continue with normal flow (query GenerationStats for actual usage)
// regardless of whether this cancel succeeds or fails.
func (a *OpenRouterAdapter) CancelGeneration(ctx context.Context, generationID string) error {
	// Type assert to OpenRouter provider
	// This assertion stays in the adapter layer where it belongs
	orProvider, ok := a.provider.(*openrouter.Provider)
	if !ok {
		return fmt.Errorf("provider is not OpenRouter provider")
	}

	// Call library provider cancel method
	return orProvider.CancelGeneration(ctx, generationID)
}
