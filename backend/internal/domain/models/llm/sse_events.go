package llm

import (
	"encoding/json"
	"fmt"
)

// SSE event type constants
// NOTE: Legacy block events (block_start, block_delta, block_stop, tool_input_update, tool_executing)
// have been removed - frontend now uses AG-UI protocol exclusively.
const (
	SSEEventTurnStart    = "turn_start"    // Turn streaming has begun
	SSEEventTurnComplete = "turn_complete" // Turn finished successfully
	SSEEventTurnError    = "turn_error"    // Turn encountered error
)

// SSEEvent represents a Server-Sent Event for turn streaming
// SSE format:
//   event: turn_start
//   data: {"turn_id": "..."}
type SSEEvent struct {
	Event string      `json:"-"`         // Event type (not serialized, used for SSE "event:" line)
	Data  interface{} `json:"data"`      // Event payload (serialized as SSE "data:" line)
}

// TurnStartEvent signals that streaming has begun for a turn
type TurnStartEvent struct {
	TurnID string `json:"turn_id"`
	Model  string `json:"model"`
}

// TurnCompleteEvent signals that the turn has finished successfully
type TurnCompleteEvent struct {
	TurnID           string                 `json:"turn_id"`
	StopReason       string                 `json:"stop_reason"`        // "end_turn", "max_tokens", "stop_sequence", "tool_use"
	InputTokens      int                    `json:"input_tokens"`
	OutputTokens     int                    `json:"output_tokens"`
	ResponseMetadata map[string]interface{} `json:"response_metadata,omitempty"`
}

// TurnErrorEvent signals that the turn encountered an error
type TurnErrorEvent struct {
	TurnID         string `json:"turn_id"`
	Error          string `json:"error"`                       // Error message
	IsCancelled    bool   `json:"is_cancelled,omitempty"`      // True if user cancelled (don't show error toast)
	LastBlockIndex *int   `json:"last_block_index,omitempty"`  // Last successfully written block (if any)
}

// FormatSSE formats an SSE event for transmission
// Returns a string in SSE format:
//   event: event_name
//   data: {"field": "value"}
//   \n
func FormatSSE(eventType string, data interface{}) (string, error) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("failed to marshal SSE event data: %w", err)
	}

	return fmt.Sprintf("event: %s\ndata: %s\n\n", eventType, string(jsonData)), nil
}

// Helper constructors for common events

// NewTurnStartEvent creates a turn_start SSE event
func NewTurnStartEvent(turnID, model string) (string, error) {
	return FormatSSE(SSEEventTurnStart, TurnStartEvent{
		TurnID: turnID,
		Model:  model,
	})
}

// NewTurnCompleteEvent creates a turn_complete SSE event
func NewTurnCompleteEvent(turnID, stopReason string, inputTokens, outputTokens int, metadata map[string]interface{}) (string, error) {
	return FormatSSE(SSEEventTurnComplete, TurnCompleteEvent{
		TurnID:           turnID,
		StopReason:       stopReason,
		InputTokens:      inputTokens,
		OutputTokens:     outputTokens,
		ResponseMetadata: metadata,
	})
}

// NewTurnErrorEvent creates a turn_error SSE event
func NewTurnErrorEvent(turnID, errorMsg string, lastBlockIndex *int) (string, error) {
	return FormatSSE(SSEEventTurnError, TurnErrorEvent{
		TurnID:         turnID,
		Error:          errorMsg,
		LastBlockIndex: lastBlockIndex,
	})
}
