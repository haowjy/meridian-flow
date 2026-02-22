package streaming

import (
	"errors"
	"strings"
	"testing"
)

func TestSanitizeProviderErrorGateway(t *testing.T) {
	raw := errors.New("failed to start provider streaming: openrouter error (HTTP 502): <!DOCTYPE html><html><body>Bad gateway</body></html>")

	got := sanitizeProviderError(raw)
	want := "Provider is temporarily unavailable (HTTP 502). Please retry."
	if got != want {
		t.Fatalf("sanitizeProviderError() = %q, want %q", got, want)
	}
}

func TestSanitizeProviderErrorStripsHTML(t *testing.T) {
	raw := errors.New("provider error: <html><body>request failed for unknown reason</body></html>")

	got := sanitizeProviderError(raw)
	if strings.Contains(got, "<html>") {
		t.Fatalf("sanitizeProviderError() should strip html, got %q", got)
	}
	if got == "" {
		t.Fatal("sanitizeProviderError() returned empty string")
	}
}

func TestIsRetryableProviderStartErrorByStatus(t *testing.T) {
	retryable := []string{
		"openrouter error (HTTP 429): rate limit",
		"openrouter error (HTTP 502): bad gateway",
		"openrouter error (HTTP 503): service unavailable",
		"openrouter error (HTTP 504): gateway timeout",
	}
	for _, raw := range retryable {
		if !isRetryableProviderStartError(errors.New(raw)) {
			t.Fatalf("expected retryable for %q", raw)
		}
	}

	notRetryable := []string{
		"openrouter error (HTTP 400): invalid request",
		"openrouter error (HTTP 401): unauthorized",
		"openrouter error (HTTP 404): model not found",
	}
	for _, raw := range notRetryable {
		if isRetryableProviderStartError(errors.New(raw)) {
			t.Fatalf("expected non-retryable for %q", raw)
		}
	}
}
