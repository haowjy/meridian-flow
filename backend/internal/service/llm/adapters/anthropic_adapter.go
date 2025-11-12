package adapters

import (
	"context"

	llmprovider "github.com/haowjy/meridian-llm-go"
	"github.com/haowjy/meridian-llm-go/providers/anthropic"

	domainllm "meridian/internal/domain/services/llm"
)

// AnthropicAdapter wraps the library's Anthropic provider and implements the backend's LLMProvider interface.
// It handles conversion between backend types (with DB fields) and library types (content-only).
type AnthropicAdapter struct {
	provider llmprovider.Provider
}

// NewAnthropicAdapter creates a new Anthropic adapter using the library's provider.
func NewAnthropicAdapter(apiKey string) (*AnthropicAdapter, error) {
	provider, err := anthropic.NewProvider(apiKey)
	if err != nil {
		return nil, err
	}

	return &AnthropicAdapter{
		provider: provider,
	}, nil
}

// Name returns the provider name.
func (a *AnthropicAdapter) Name() string {
	return a.provider.Name()
}

// SupportsModel returns true if this provider supports the given model.
func (a *AnthropicAdapter) SupportsModel(model string) bool {
	return a.provider.SupportsModel(model)
}

// GenerateResponse generates a response from Claude.
func (a *AnthropicAdapter) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
	// Convert backend request to library request
	libReq := convertToLibraryRequest(req)

	// Call library provider
	libResp, err := a.provider.GenerateResponse(ctx, libReq)
	if err != nil {
		return nil, err
	}

	// Convert library response to backend response
	return convertFromLibraryResponse(libResp), nil
}

// StreamResponse generates a streaming response from Claude.
func (a *AnthropicAdapter) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Convert backend request to library request
	libReq := convertToLibraryRequest(req)

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
