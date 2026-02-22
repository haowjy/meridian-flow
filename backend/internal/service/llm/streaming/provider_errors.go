package streaming

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	providerStartMaxAttempts = 2
	providerStartRetryDelay  = 750 * time.Millisecond
	maxUserErrorMessageLen   = 240
)

var (
	httpStatusCodePattern = regexp.MustCompile(`(?i)HTTP\s*([0-9]{3})`)
	htmlTagPattern        = regexp.MustCompile(`(?s)<[^>]+>`)
	whitespacePattern     = regexp.MustCompile(`\s+`)
)

// sanitizeProviderError converts raw provider errors (which can contain large HTML payloads)
// into concise, user-facing messages suitable for DB persistence and UI display.
func sanitizeProviderError(err error) string {
	if err == nil {
		return "Provider request failed"
	}

	raw := strings.TrimSpace(err.Error())
	if raw == "" {
		return "Provider request failed"
	}

	if statusCode, ok := extractHTTPStatusCode(raw); ok {
		switch statusCode {
		case 408:
			return "Provider request timed out (HTTP 408). Please retry."
		case 429:
			return "Provider is rate-limiting requests (HTTP 429). Please retry shortly."
		case 502, 503, 504:
			return fmt.Sprintf("Provider is temporarily unavailable (HTTP %d). Please retry.", statusCode)
		}
	}

	summary := summarizeProviderError(raw)
	if summary == "" {
		return "Provider request failed"
	}
	return summary
}

// isRetryableProviderStartError returns true for startup errors that are typically transient.
func isRetryableProviderStartError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	raw := strings.TrimSpace(err.Error())
	if raw == "" {
		return false
	}

	if statusCode, ok := extractHTTPStatusCode(raw); ok {
		switch statusCode {
		case 408, 429, 500, 502, 503, 504:
			return true
		}
	}

	lower := strings.ToLower(raw)
	retryableHints := []string{
		"bad gateway",
		"service unavailable",
		"gateway timeout",
		"timeout",
		"temporary",
		"temporarily",
		"connection reset",
		"connection refused",
		"connection aborted",
		"unexpected eof",
	}
	for _, hint := range retryableHints {
		if strings.Contains(lower, hint) {
			return true
		}
	}

	return false
}

func extractHTTPStatusCode(raw string) (int, bool) {
	matches := httpStatusCodePattern.FindStringSubmatch(raw)
	if len(matches) < 2 {
		return 0, false
	}

	code, err := strconv.Atoi(matches[1])
	if err != nil {
		return 0, false
	}
	return code, true
}

func summarizeProviderError(raw string) string {
	normalized := strings.TrimSpace(raw)
	if normalized == "" {
		return ""
	}

	if looksLikeHTML(normalized) {
		normalized = htmlTagPattern.ReplaceAllString(normalized, " ")
	}

	normalized = whitespacePattern.ReplaceAllString(normalized, " ")
	normalized = strings.TrimSpace(normalized)
	if normalized == "" {
		return ""
	}

	if len(normalized) > maxUserErrorMessageLen {
		return normalized[:maxUserErrorMessageLen-3] + "..."
	}
	return normalized
}

func looksLikeHTML(raw string) bool {
	lower := strings.ToLower(raw)
	return strings.Contains(lower, "<!doctype html") ||
		strings.Contains(lower, "<html") ||
		strings.Contains(lower, "</html") ||
		strings.Contains(lower, "<body")
}
