package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/handler/sse"
	"meridian/internal/httputil"
)

// SSEHandler handles Server-Sent Events for streaming turn responses
// Follows Dependency Inversion Principle - depends on KeepAliveStrategy interface
type SSEHandler struct {
	registry         *mstream.Registry
	logger           *slog.Logger
	config           *sse.Config
	keepAliveFactory func(time.Duration) sse.KeepAliveStrategy
}

// NewSSEHandler creates a new SSE handler
// Dependency Injection: Accepts config instead of hardcoding values
func NewSSEHandler(
	registry *mstream.Registry,
	logger *slog.Logger,
	config *sse.Config,
) *SSEHandler {
	return &SSEHandler{
		registry: registry,
		logger:   logger,
		config:   config,
		// Factory for creating keep-alive strategies (testable via injection)
		keepAliveFactory: func(interval time.Duration) sse.KeepAliveStrategy {
			return sse.NewTickerKeepAlive(interval)
		},
	}
}

// safeFlush flushes the response and checks if the connection is still healthy
// Returns an error if the connection has been closed/broken
func (h *SSEHandler) safeFlush(w http.ResponseWriter, flusher http.Flusher, turnID, clientID string) error {
	// Flush buffered data
	flusher.Flush()

	// Check connection health by attempting a zero-byte write
	// If connection is closed, this will return an error
	if _, err := w.Write([]byte{}); err != nil {
		h.logger.Warn("flush failed, client likely disconnected",
			"turn_id", turnID,
			"client_id", clientID,
			"error", err,
		)
		return err
	}

	return nil
}

// StreamTurn handles GET /api/turns/{id}/stream
// Streams turn events via Server-Sent Events (SSE)
func (h *SSEHandler) StreamTurn(w http.ResponseWriter, r *http.Request) {
	turnID := r.PathValue("id")
	clientIP := r.RemoteAddr

	h.logger.Info("SSE connection request",
		"turn_id", turnID,
		"client_ip", clientIP,
	)

	// Validate turn ID
	if _, err := uuid.Parse(turnID); err != nil {
		h.logger.Warn("invalid turn ID format",
			"turn_id", turnID,
			"error", err,
		)
		httputil.RespondError(w, http.StatusBadRequest, "invalid turn ID format")
		return
	}

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Get the http.Flusher - required for SSE
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.logger.Error("ResponseWriter does not support flushing",
			"turn_id", turnID,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	// Get Stream from registry
	stream := h.registry.Get(turnID)
	if stream == nil {
		h.logger.Warn("stream not found for SSE connection",
			"turn_id", turnID,
			"client_ip", clientIP,
		)
		// Don't return early - establish SSE connection first, then send error
	} else {
		h.logger.Info("stream found for SSE connection",
			"turn_id", turnID,
			"client_ip", clientIP,
		)
	}

	// Generate client ID
	clientID := uuid.New().String()

	// Read Last-Event-ID header
	lastEventID := r.Header.Get("Last-Event-ID")

	// Write 200 status and flush headers
	w.WriteHeader(http.StatusOK)
	if err := h.safeFlush(w, flusher, turnID, clientID); err != nil {
		// Client disconnected before stream established
		return
	}

	// If no stream, send error event and close gracefully
	if stream == nil {
		errorData, _ := json.Marshal(llmModels.TurnErrorEvent{
			TurnID: turnID,
			Error:  "streaming not active for this turn",
		})
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", llmModels.SSEEventTurnError, string(errorData))
		if err := h.safeFlush(w, flusher, turnID, clientID); err != nil {
			// Client disconnected, error already logged
			return
		}
		h.logger.Info("sent error event for missing stream, closing stream",
			"turn_id", turnID,
			"client_id", clientID,
		)
		return
	}

	// If stream exists but is no longer running, do not replay.
	// Clear the buffer to avoid lingering in-memory events and close immediately.
	status := stream.Status()
	if status == mstream.StatusComplete ||
		status == mstream.StatusError ||
		status == mstream.StatusCancelled {
		// Clear buffer after completion to prevent 10-minute replay semantics.
		stream.ClearBuffer()
		return
	}

	// Get catchup events (for first connection or reconnection)
	catchupEvents := stream.GetCatchupEvents(lastEventID)
	if len(catchupEvents) > 0 {
		// Send catchup events
		for _, event := range catchupEvents {
			if event.Type != "" {
				fmt.Fprintf(w, "event: %s\n", event.Type)
			}
			if event.ID != "" {
				fmt.Fprintf(w, "id: %s\n", event.ID)
			}
			if event.Retry > 0 {
				fmt.Fprintf(w, "retry: %d\n", event.Retry)
			}
			fmt.Fprintf(w, "data: %s\n\n", string(event.Data))

			if err := h.safeFlush(w, flusher, turnID, clientID); err != nil {
				// Client disconnected during catchup
				return
			}
		}
	}

	// Check if stream is already done (completed/error/cancelled)
	status = stream.Status()
	if status == mstream.StatusComplete ||
		status == mstream.StatusError ||
		status == mstream.StatusCancelled {
		return // Close SSE connection gracefully
	}

	// Stream still active - add client to stream (get event channel for live events)
	eventChan := stream.AddClient(clientID)
	defer stream.RemoveClient(clientID)

	// Initialize keep-alive strategy (Dependency Inversion Principle)
	// SSEHandler depends on KeepAliveStrategy interface, not concrete implementation
	keepAliveWriter := sse.NewSSEKeepAliveWriter(w, flusher, turnID, clientID)
	keepAliveStrategy := h.keepAliveFactory(h.config.KeepAliveInterval)
	defer keepAliveStrategy.Stop()

	// Start keep-alive in background
	// Returns channel that closes if keep-alive fails (e.g., connection dropped)
	keepAliveDone := keepAliveStrategy.Start(keepAliveWriter, h.logger)

	// Event loop: Stream events until completion or connection drop
	for {
		select {
		case event, ok := <-eventChan:
			if !ok {
				// Channel closed - streaming complete/error/cancelled
				return
			}

			// Format mstream.Event as SSE
			if event.Type != "" {
				fmt.Fprintf(w, "event: %s\n", event.Type)
			}
			if event.ID != "" {
				fmt.Fprintf(w, "id: %s\n", event.ID)
			}
			if event.Retry > 0 {
				fmt.Fprintf(w, "retry: %d\n", event.Retry)
			}
			fmt.Fprintf(w, "data: %s\n\n", string(event.Data))

			if err := h.safeFlush(w, flusher, turnID, clientID); err != nil {
				// Client disconnected during event stream
				return
			}

		case <-keepAliveDone:
			// Keep-alive failed (connection dropped)
			return
		}
	}
}
