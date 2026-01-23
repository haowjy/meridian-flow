package agui

import (
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// ============================================================================
// Meridian-Extended AG-UI Events
//
// These types extend the official AG-UI events with Meridian-specific fields.
// They are LSP-compliant: can be used anywhere AG-UI events are expected.
// Extra fields are ignored by pure AG-UI clients but used by Meridian frontend.
// ============================================================================

// MeridianRunStartedEvent extends RUN_STARTED with reconnection support.
// lastBlockSequence tells reconnecting clients where to start indexing new blocks.
type MeridianRunStartedEvent struct {
	Type              events.EventType `json:"type"`
	ThreadID          string           `json:"threadId,omitempty"`
	RunID             string           `json:"runId,omitempty"`
	TurnID            string           `json:"turnId,omitempty"`            // Raw turn ID for Meridian use (avoids parsing runId)
	LastBlockSequence *int             `json:"lastBlockSequence,omitempty"` // Omitted on first connection, present on reconnection
}

// NewMeridianRunStartedEvent creates a RUN_STARTED event with optional lastBlockSequence.
// Pass nil for lastBlockSequence on first connection (no blocks exist yet).
// Pass the last persisted block sequence on reconnection.
func NewMeridianRunStartedEvent(threadID, runID, turnID string, lastBlockSequence *int) *MeridianRunStartedEvent {
	return &MeridianRunStartedEvent{
		Type:              events.EventTypeRunStarted,
		ThreadID:          threadID,
		RunID:             runID,
		TurnID:            turnID,
		LastBlockSequence: lastBlockSequence,
	}
}

// MeridianRunFinishedEvent extends RUN_FINISHED with LLM metadata.
type MeridianRunFinishedEvent struct {
	Type         events.EventType `json:"type"`
	ThreadID     string           `json:"threadId,omitempty"`
	RunID        string           `json:"runId,omitempty"`
	TurnID       string           `json:"turnId,omitempty"` // Raw turn ID for Meridian use (avoids parsing runId)
	StopReason   string           `json:"stopReason,omitempty"`
	InputTokens  int              `json:"inputTokens,omitempty"`
	OutputTokens int              `json:"outputTokens,omitempty"`
}

// NewMeridianRunFinishedEvent creates a RUN_FINISHED event with LLM metadata.
func NewMeridianRunFinishedEvent(threadID, runID, turnID, stopReason string, inputTokens, outputTokens int) *MeridianRunFinishedEvent {
	return &MeridianRunFinishedEvent{
		Type:         events.EventTypeRunFinished,
		ThreadID:     threadID,
		RunID:        runID,
		TurnID:       turnID,
		StopReason:   stopReason,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
	}
}

// MeridianRunErrorEvent extends RUN_ERROR with cancellation distinction.
type MeridianRunErrorEvent struct {
	Type        events.EventType `json:"type"`
	ThreadID    string           `json:"threadId,omitempty"`
	RunID       string           `json:"runId,omitempty"`
	TurnID      string           `json:"turnId,omitempty"` // Raw turn ID for Meridian use (avoids parsing runId)
	Message     string           `json:"message"`
	IsCancelled bool             `json:"isCancelled,omitempty"` // True = user cancel, don't show error toast
}

// NewMeridianRunErrorEvent creates a RUN_ERROR event with cancellation flag.
func NewMeridianRunErrorEvent(threadID, runID, turnID, message string, isCancelled bool) *MeridianRunErrorEvent {
	return &MeridianRunErrorEvent{
		Type:        events.EventTypeRunError,
		ThreadID:    threadID,
		RunID:       runID,
		TurnID:      turnID,
		Message:     message,
		IsCancelled: isCancelled,
	}
}
