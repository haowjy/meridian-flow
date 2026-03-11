package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"time"

	"golang.org/x/net/websocket"
)

// messageLoopHandlers defines callbacks for the shared websocket receive loop.
// The loop handles receive, rate-limiting, empty-message guard, and JSON-vs-binary
// dispatch. Each callback returns true if the message was handled.
type messageLoopHandlers struct {
	// onTextMessage is called when a JSON message (starts with '{') is received.
	// Returns true if handled (even if it resulted in an error).
	onTextMessage func(raw []byte) bool

	// onBinaryMessage is called when a non-JSON binary message is received.
	onBinaryMessage func(raw []byte)
}

// messageLoopConfig holds configuration for the shared websocket message loop.
type messageLoopConfig struct {
	// logContext is a set of key-value pairs added to all log messages.
	logContext []any
}

// runMessageLoop runs the shared websocket inbound message loop.
//
// It handles:
//   - Receive loop around websocket.Message.Receive
//   - Inbound rate limiting via collabInboundRateTracker
//   - Empty-message guard
//   - JSON-first dispatch then binary fallback
//   - Forward-compat: unknown JSON/binary messages stay non-fatal
//
// The loop returns when the connection is closed or a read error occurs.
func runMessageLoop(
	conn *websocket.Conn,
	wsConn *websocketDocumentConnection,
	handlers messageLoopHandlers,
	cfg messageLoopConfig,
	logger *slog.Logger,
) {
	inboundRateTracker := collabInboundRateTracker{}

	for {
		var rawMessage []byte
		if err := websocket.Message.Receive(conn, &rawMessage); err != nil {
			if !errors.Is(err, io.EOF) {
				logger.Debug("websocket receive failed", append(cfg.logContext,
					"connection_id", wsConn.ID(),
					"error", err,
				)...)
			}
			return
		}

		allowed, limitExceeded := inboundRateTracker.allowInbound(time.Now())
		if !allowed {
			if limitExceeded {
				sendRateLimitError(wsConn, logger, cfg.logContext)
			}
			continue
		}

		if len(rawMessage) == 0 {
			continue
		}

		// Try JSON message handling first
		if handlers.onTextMessage != nil {
			if handled := handlers.onTextMessage(rawMessage); handled {
				continue
			}
		}

		// Binary message handling
		if handlers.onBinaryMessage != nil {
			handlers.onBinaryMessage(rawMessage)
		}
		// Unknown format: silently drop for forward compatibility
	}
}

// sendRateLimitError sends a rate-limit error and logs a warning.
func sendRateLimitError(
	wsConn *websocketDocumentConnection,
	logger *slog.Logger,
	logContext []any,
) {
	err := wsConn.SendJSON(collabErrorMessage{
		Type:    "error",
		Code:    "RATE_LIMITED",
		Message: "too many inbound messages; muted for 1 second",
	})
	if err != nil && !errors.Is(err, io.EOF) {
		logger.Debug("websocket failed to send rate-limit error", append(logContext,
			"connection_id", wsConn.ID(),
			"error", err,
		)...)
	}
	logger.Warn("websocket inbound rate limited", append(logContext,
		"connection_id", wsConn.ID(),
		"rate_limit_per_sec", collabInboundRateLimit,
		"mute_seconds", collabInboundMutePeriod.Seconds(),
	)...)
}

// isJSONMessage returns true if the raw bytes look like a JSON object.
func isJSONMessage(raw []byte) bool {
	return len(raw) > 0 && raw[0] == '{'
}

// tryParseTypedMessage attempts to unmarshal a JSON message type field.
// Returns the type string and true if the message is valid JSON with a type field.
func tryParseTypedMessage(raw []byte) (string, bool) {
	if !isJSONMessage(raw) {
		return "", false
	}
	var typed collabTypedMessage
	if err := json.Unmarshal(raw, &typed); err != nil {
		return "", false
	}
	return typed.Type, true
}
