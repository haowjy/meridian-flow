package adapters

import (
	"context"
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"
	"github.com/haowjy/meridian-llm-go/providers/anthropic"

	domainllm "meridian/internal/domain/services/llm"
)

// AnthropicAdapter wraps the library's Anthropic provider and implements the backend's LLMProvider interface.
// It handles conversion between backend types (with DB fields) and library types (content-only).
type AnthropicAdapter struct {
	provider llmprovider.Provider
}

// NewAnthropicAdapterWithProvider creates a new Anthropic adapter from an existing provider.
// Used by provider factory for dynamic provider creation.
func NewAnthropicAdapterWithProvider(provider llmprovider.Provider) *AnthropicAdapter {
	return &AnthropicAdapter{
		provider: provider,
	}
}

// Name returns the provider name.
func (a *AnthropicAdapter) Name() string {
	return a.provider.Name().String()
}

// SupportsModel returns true if this provider supports the given model.
func (a *AnthropicAdapter) SupportsModel(model string) bool {
	return a.provider.SupportsModel(model)
}

// GenerateResponse generates a response from Claude.
func (a *AnthropicAdapter) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
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

// StreamResponse generates a streaming response from Claude.
func (a *AnthropicAdapter) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Convert backend request to library request
	libReq, err := ConvertToLibraryRequest(req)
	if err != nil {
		return nil, err
	}

	// Call library provider
	libStream, err := a.provider.StreamResponse(ctx, libReq)
	if err != nil {
		return nil, err
	}

	// Create backend event channel
	backendEventCh := make(chan domainllm.StreamEvent)

	// Convert library events to backend events
	go func() {
		defer close(backendEventCh)
		defer libStream.Close()
		for libStream.Next() {
			select {
			case backendEventCh <- convertFromLibraryEvent(libStream.Event()):
			case <-ctx.Done():
				return
			}
		}
		if err := libStream.Err(); err != nil {
			select {
			case backendEventCh <- domainllm.StreamEvent{Error: err}:
			case <-ctx.Done():
			}
		}
	}()

	return backendEventCh, nil
}

// BuildDebugProviderRequest builds the Anthropic provider request payload for debugging.
// It converts the backend GenerateRequest to the library format and then to
// Anthropic MessageNewParams JSON using the meridian-llm-go helper.
func (a *AnthropicAdapter) BuildDebugProviderRequest(ctx context.Context, req *domainllm.GenerateRequest) (map[string]interface{}, error) {
	// Convert backend request to library request
	libReq, err := ConvertToLibraryRequest(req)
	if err != nil {
		return nil, err
	}

	// Cast provider to Anthropic-specific type to access debug method
	anthropicProvider, ok := a.provider.(*anthropic.Provider)
	if !ok {
		return nil, fmt.Errorf("provider is not an Anthropic provider")
	}

	// Build provider-specific params JSON using library helper method
	return anthropicProvider.BuildMessageParamsDebug(libReq)
}
