package handler

import (
	"testing"
	"time"
)

func TestMessageLoop_TryParseTypedMessage_ValidJSON(t *testing.T) {
	msgType, ok := tryParseTypedMessage([]byte(`{"type":"heartbeat"}`))
	if !ok {
		t.Fatal("expected ok=true for valid JSON")
	}
	if msgType != "heartbeat" {
		t.Fatalf("expected heartbeat, got %q", msgType)
	}
}

func TestMessageLoop_TryParseTypedMessage_InvalidJSON(t *testing.T) {
	_, ok := tryParseTypedMessage([]byte(`{invalid`))
	if ok {
		t.Fatal("expected ok=false for invalid JSON")
	}
}

func TestMessageLoop_TryParseTypedMessage_BinaryMessage(t *testing.T) {
	_, ok := tryParseTypedMessage([]byte{0x00, 0x01, 0x02})
	if ok {
		t.Fatal("expected ok=false for binary message")
	}
}

func TestMessageLoop_TryParseTypedMessage_EmptyMessage(t *testing.T) {
	_, ok := tryParseTypedMessage([]byte{})
	if ok {
		t.Fatal("expected ok=false for empty message")
	}
}

func TestMessageLoop_IsJSONMessage(t *testing.T) {
	tests := []struct {
		name     string
		input    []byte
		expected bool
	}{
		{"empty", []byte{}, false},
		{"json object", []byte(`{"type":"foo"}`), true},
		{"binary", []byte{0x00, 0x01}, false},
		{"json array", []byte(`["a"]`), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isJSONMessage(tt.input)
			if got != tt.expected {
				t.Fatalf("isJSONMessage(%v) = %v, want %v", tt.input, got, tt.expected)
			}
		})
	}
}

// TestMessageLoop_RateLimiter_MuteWindow verifies the rate limiter enters a mute window
// after the limit is exceeded, and that messages are silently dropped during the window.
func TestMessageLoop_RateLimiter_MuteWindow(t *testing.T) {
	tracker := collabInboundRateTracker{}
	now := time.Now()

	// Send up to the limit — all should be allowed
	for i := 0; i < collabInboundRateLimit; i++ {
		allowed, exceeded := tracker.allowInbound(now)
		if !allowed || exceeded {
			t.Fatalf("message %d should be allowed, got allowed=%v exceeded=%v", i, allowed, exceeded)
		}
	}

	// Next message should trigger the mute window
	allowed, exceeded := tracker.allowInbound(now)
	if allowed || !exceeded {
		t.Fatalf("message at limit should be rate-limited, got allowed=%v exceeded=%v", allowed, exceeded)
	}

	// During the mute window, messages are silently dropped (exceeded=false)
	allowed, exceeded = tracker.allowInbound(now.Add(500 * time.Millisecond))
	if allowed || exceeded {
		t.Fatalf("message during mute window should be silently dropped, got allowed=%v exceeded=%v", allowed, exceeded)
	}

	// After the mute period, messages should be allowed again
	allowed, exceeded = tracker.allowInbound(now.Add(collabInboundMutePeriod + time.Millisecond))
	if !allowed || exceeded {
		t.Fatalf("message after mute period should be allowed, got allowed=%v exceeded=%v", allowed, exceeded)
	}
}

// TestMessageLoop_RateLimiter_WindowReset verifies that the rate limit window resets
// after the window period elapses.
func TestMessageLoop_RateLimiter_WindowReset(t *testing.T) {
	tracker := collabInboundRateTracker{}
	now := time.Now()

	// Send up to the limit
	for i := 0; i < collabInboundRateLimit; i++ {
		allowed, _ := tracker.allowInbound(now)
		if !allowed {
			t.Fatalf("message %d within limit should be allowed", i)
		}
	}

	// New window should reset the count
	nextWindow := now.Add(collabInboundRateWindow + time.Millisecond)
	allowed, exceeded := tracker.allowInbound(nextWindow)
	if !allowed || exceeded {
		t.Fatalf("first message in new window should be allowed, got allowed=%v exceeded=%v", allowed, exceeded)
	}
}
