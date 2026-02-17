package tools

import (
	"context"
	"testing"
)

func TestInjectExtractThreadContext_RoundTrip(t *testing.T) {
	ctx := context.Background()
	ctx = InjectThreadContext(ctx, "thread-123", "turn-456", "user-789")

	threadID, turnID, userID, ok := ExtractThreadContext(ctx)
	if !ok {
		t.Fatal("expected ok=true, got false")
	}
	if threadID != "thread-123" {
		t.Errorf("threadID = %q, want %q", threadID, "thread-123")
	}
	if turnID != "turn-456" {
		t.Errorf("turnID = %q, want %q", turnID, "turn-456")
	}
	if userID != "user-789" {
		t.Errorf("userID = %q, want %q", userID, "user-789")
	}
}

func TestExtractThreadContext_EmptyContext(t *testing.T) {
	ctx := context.Background()

	_, _, _, ok := ExtractThreadContext(ctx)
	if ok {
		t.Fatal("expected ok=false for empty context, got true")
	}
}

func TestExtractThreadContext_PartialContext(t *testing.T) {
	tests := []struct {
		name     string
		threadID string
		turnID   string
		userID   string
	}{
		{"missing userID", "thread-1", "turn-1", ""},
		{"missing turnID", "thread-1", "", "user-1"},
		{"missing threadID", "", "turn-1", "user-1"},
		{"only threadID", "thread-1", "", ""},
		{"only turnID", "", "turn-1", ""},
		{"only userID", "", "", "user-1"},
		{"all empty", "", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			// Manually inject partial values to test extraction
			if tt.threadID != "" {
				ctx = context.WithValue(ctx, threadIDKey{}, tt.threadID)
			}
			if tt.turnID != "" {
				ctx = context.WithValue(ctx, turnIDKey{}, tt.turnID)
			}
			if tt.userID != "" {
				ctx = context.WithValue(ctx, userIDKey{}, tt.userID)
			}

			_, _, _, ok := ExtractThreadContext(ctx)
			if ok {
				t.Errorf("expected ok=false for partial context %q, got true", tt.name)
			}
		})
	}
}
