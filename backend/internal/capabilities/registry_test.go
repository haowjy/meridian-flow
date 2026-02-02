package capabilities

import "testing"

func TestGetModelCapabilities_OpenRouterVariantMatchesBase(t *testing.T) {
	r, err := NewRegistry()
	if err != nil {
		t.Fatalf("NewRegistry() error: %v", err)
	}

	// OpenRouter can report a versioned model ID at runtime.
	// Our capability registry stores stable IDs without the -YYYY-MM-DD suffix.
	caps, err := r.GetModelCapabilities("openrouter", "google/gemini-2.5-flash-2025-08-07")
	if err != nil {
		t.Fatalf("GetModelCapabilities() error: %v", err)
	}
	if caps == nil {
		t.Fatal("caps is nil")
	} else if !caps.SupportsStreamingCancel {
		t.Fatalf("SupportsStreamingCancel = %v, want true", caps.SupportsStreamingCancel)
	}
}

func TestGetModelCapabilities_OpenRouterOnlineVariantMatchesBase(t *testing.T) {
	r, err := NewRegistry()
	if err != nil {
		t.Fatalf("NewRegistry() error: %v", err)
	}

	// :online is used for web search variants; capabilities are stored for the base model.
	_, err = r.GetModelCapabilities("openrouter", "moonshotai/kimi-k2-thinking:online")
	if err != nil {
		t.Fatalf("GetModelCapabilities() error: %v", err)
	}
}
