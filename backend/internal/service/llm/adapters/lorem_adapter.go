package adapters

import (
	"context"

	llmprovider "github.com/haowjy/meridian-llm-go"

	domainllm "meridian/internal/domain/llm"
)

// LoremAdapter wraps the library's Lorem provider and implements the backend's LLMProvider interface.
// It handles conversion between backend types (with DB fields) and library types (content-only).
type LoremAdapter struct {
	provider llmprovider.Provider
}

// NewLoremAdapterWithProvider creates a new Lorem adapter from an existing provider.
// Used by provider factory for dynamic provider creation.
func NewLoremAdapterWithProvider(provider llmprovider.Provider) *LoremAdapter {
	return &LoremAdapter{
		provider: provider,
	}
}

// Name returns the provider name.
func (a *LoremAdapter) Name() string {
	return a.provider.Name().String()
}

// SupportsModel returns true if this provider supports the given model.
func (a *LoremAdapter) SupportsModel(model string) bool {
	return a.provider.SupportsModel(model)
}

// GenerateResponse generates a response from Lorem provider.
func (a *LoremAdapter) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
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

// StreamResponse generates a streaming response from Lorem provider.
func (a *LoremAdapter) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
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
