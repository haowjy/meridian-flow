package handler

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/service/llm/streaming"
)

// SSEHandler handles Server-Sent Events for streaming turn responses
type SSEHandler struct {
	registry *streaming.TurnExecutorRegistry
	logger   *slog.Logger
}

// NewSSEHandler creates a new SSE handler
func NewSSEHandler(registry *streaming.TurnExecutorRegistry, logger *slog.Logger) *SSEHandler {
	return &SSEHandler{
		registry: registry,
		logger:   logger,
	}
}

// StreamTurn handles GET /api/turns/:id/stream
// Streams turn events via Server-Sent Events (SSE)
func (h *SSEHandler) StreamTurn(c *fiber.Ctx) error {
	turnID := c.Params("id")
	clientIP := c.IP()

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
		return fiber.NewError(fiber.StatusBadRequest, "invalid turn ID format")
	}

	// Set SSE headers
	c.Set("Content-Type", "text/event-stream")
	c.Set("Cache-Control", "no-cache")
	c.Set("Connection", "keep-alive")
	c.Set("Transfer-Encoding", "chunked")
	c.Set("X-Accel-Buffering", "no") // Disable nginx buffering

	// Get TurnExecutor from registry
	executor := h.registry.Get(turnID)
	if executor == nil {
		h.logger.Warn("executor not found for SSE connection",
			"turn_id", turnID,
			"client_ip", clientIP,
		)
		// Don't return early - establish SSE connection first, then send error
	} else {
		h.logger.Info("executor found for SSE connection",
			"turn_id", turnID,
			"client_ip", clientIP,
		)
	}

	// Generate client ID
	clientID := uuid.New().String()

	// Stream events to client
	c.Status(fiber.StatusOK).Context().SetBodyStreamWriter(func(w *bufio.Writer) {
		// Check initial flush to detect dead connections early
		if err := w.Flush(); err != nil {
			h.logger.Error("initial flush failed - connection already dead",
				"turn_id", turnID,
				"client_id", clientID,
				"error", err,
			)
			return
		}

		h.logger.Debug("SSE stream established",
			"turn_id", turnID,
			"client_id", clientID,
		)

		// If no executor, send error event and close gracefully
		if executor == nil {
			errorEvent, _ := llmModels.NewTurnErrorEvent(turnID, "streaming not active for this turn", nil)
			fmt.Fprintf(w, "%s", errorEvent)
			w.Flush()
			h.logger.Info("sent error event for missing executor, closing stream",
				"turn_id", turnID,
				"client_id", clientID,
			)
			return
		}

		// Register client with executor (get event channel)
		eventChan := executor.AddClient(clientID)
		defer func() {
			executor.RemoveClient(clientID)
			h.logger.Debug("SSE client removed",
				"turn_id", turnID,
				"client_id", clientID,
			)
		}()

		h.logger.Debug("SSE client registered",
			"turn_id", turnID,
			"client_id", clientID,
		)

		// Get bidirectional channel for reconnection (to write catchup events)
		clientChan := executor.GetClientChannel(clientID)

		// Send catchup events for reconnection
		// IMPORTANT: Use context.Background() here, not c.Context()
		// We're inside a goroutine spawned by SetBodyStreamWriter, and the Fiber context
		// is not valid in this goroutine. Using c.Context() causes nil pointer dereference.
		if err := executor.HandleReconnection(context.Background(), clientID, clientChan); err != nil {
			h.logger.Warn("catchup failed, client will receive live events only",
				"turn_id", turnID,
				"client_id", clientID,
				"error", err,
			)
		} else {
			h.logger.Debug("catchup completed",
				"turn_id", turnID,
				"client_id", clientID,
			)
		}

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

				// Write event to client
				fmt.Fprintf(w, "%s", event)
				if err := w.Flush(); err != nil {
					// Client disconnected (detected via flush error)
					h.logger.Info("client disconnected during event write",
						"turn_id", turnID,
						"client_id", clientID,
						"error", err,
					)
					return
				}

				h.logger.Debug("SSE event sent",
					"turn_id", turnID,
					"client_id", clientID,
				)

			case <-ticker.C:
				// Send keepalive comment
				fmt.Fprintf(w, ": keepalive\n\n")
				if err := w.Flush(); err != nil {
					// Client disconnected (detected via flush error)
					h.logger.Info("client disconnected during keepalive",
						"turn_id", turnID,
						"client_id", clientID,
						"error", err,
					)
					return
				}

				h.logger.Debug("keepalive sent",
					"turn_id", turnID,
					"client_id", clientID,
				)
			}
		}
	})

	h.logger.Debug("SSE stream ended",
		"turn_id", turnID,
		"client_id", clientID,
	)

	return nil
}
