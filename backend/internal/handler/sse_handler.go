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
	"meridian/internal/httputil"
)

// SSEHandler handles Server-Sent Events for streaming turn responses
type SSEHandler struct {
	registry *mstream.Registry
	logger   *slog.Logger
}

// NewSSEHandler creates a new SSE handler
func NewSSEHandler(registry *mstream.Registry, logger *slog.Logger) *SSEHandler {
	return &SSEHandler{
		registry: registry,
		logger:   logger,
	}
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
	flusher.Flush() // No error checking - connection status detected on next write

	h.logger.Debug("SSE stream established",
		"turn_id", turnID,
		"client_id", clientID,
	)

	// If no stream, send error event and close gracefully
	if stream == nil {
		errorData, _ := json.Marshal(llmModels.TurnErrorEvent{
			TurnID: turnID,
			Error:  "streaming not active for this turn",
		})
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", llmModels.SSEEventTurnError, string(errorData))
		flusher.Flush() // No error checking - connection status detected on next write
		h.logger.Info("sent error event for missing stream, closing stream",
			"turn_id", turnID,
			"client_id", clientID,
		)
		return
	}

	h.logger.Debug("SSE connection details",
		"turn_id", turnID,
		"client_id", clientID,
		"last_event_id", lastEventID,
	)

	// Get catchup events (for first connection or reconnection)
	catchupEvents := stream.GetCatchupEvents(lastEventID)
	if len(catchupEvents) > 0 {
		h.logger.Debug("sending catchup events",
			"turn_id", turnID,
			"client_id", clientID,
			"last_event_id", lastEventID,
			"catchup_count", len(catchupEvents),
		)

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

			flusher.Flush() // No error checking - connection status detected on next write
			h.logger.Debug("catchup event sent",
				"turn_id", turnID,
				"client_id", clientID,
				"event_id", event.ID,
			)
		}

		h.logger.Debug("catchup events sent",
			"turn_id", turnID,
			"client_id", clientID,
			"catchup_count", len(catchupEvents),
		)
	}

	// Check if stream is already done (completed/error/cancelled)
	status := stream.Status()
	if status == mstream.StatusComplete ||
		status == mstream.StatusError ||
		status == mstream.StatusCancelled {
		h.logger.Debug("stream already finished, closing connection",
			"turn_id", turnID,
			"client_id", clientID,
			"status", status,
		)
		return // Close SSE connection gracefully
	}

	// Stream still active - add client to stream (get event channel for live events)
	eventChan := stream.AddClient(clientID)
	defer func() {
		stream.RemoveClient(clientID)
		h.logger.Debug("SSE client removed",
			"turn_id", turnID,
			"client_id", clientID,
		)
	}()

	h.logger.Debug("SSE client registered with stream",
		"turn_id", turnID,
		"client_id", clientID,
	)

	// Send keepalive comments every 15 seconds to prevent timeout
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case event, ok := <-eventChan:
			if !ok {
				// Channel closed - streaming complete/error/cancelled
				h.logger.Debug("event channel closed, ending stream",
					"turn_id", turnID,
					"client_id", clientID,
				)
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

			flusher.Flush() // No error checking - connection status detected on next write
			h.logger.Debug("SSE event sent",
				"turn_id", turnID,
				"client_id", clientID,
				"event_type", event.Type,
			)

		case <-ticker.C:
			// Send keepalive comment
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush() // No error checking - connection status detected on next write

			h.logger.Debug("keepalive sent",
				"turn_id", turnID,
				"client_id", clientID,
			)
		}
	}
}
