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

// ============================================================================
// Meridian Interjection Events
//
// These custom events support the interjection feature where users can
// submit messages while an assistant turn is streaming.
// ============================================================================

// MeridianEventTypeStreamSwitch is emitted when an interjection triggers a stream switch.
const MeridianEventTypeStreamSwitch = "STREAM_SWITCH"

// MeridianEventTypeCreditsExhausted is emitted when step-level admission denies a provider call.
const MeridianEventTypeCreditsExhausted = "CREDITS_EXHAUSTED"

// MeridianCreditsExhaustedEvent is sent when streaming ends due to insufficient credits.
type MeridianCreditsExhaustedEvent struct {
	Type         string `json:"type"`
	ThreadID     string `json:"threadId,omitempty"`
	RunID        string `json:"runId,omitempty"`
	TurnID       string `json:"turnId,omitempty"`
	RequestIndex int    `json:"requestIndex"`
	Phase        string `json:"phase"`
	Message      string `json:"message"`
}

// NewMeridianCreditsExhaustedEvent creates a CREDITS_EXHAUSTED event.
func NewMeridianCreditsExhaustedEvent(
	threadID string,
	runID string,
	turnID string,
	requestIndex int,
	phase string,
) *MeridianCreditsExhaustedEvent {
	return &MeridianCreditsExhaustedEvent{
		Type:         MeridianEventTypeCreditsExhausted,
		ThreadID:     threadID,
		RunID:        runID,
		TurnID:       turnID,
		RequestIndex: requestIndex,
		Phase:        phase,
		Message:      "insufficient credits",
	}
}

// StreamSwitchReason describes why a stream switch occurred.
type StreamSwitchReason string

const (
	// StreamSwitchReasonToolBoundary indicates switch after tool execution.
	StreamSwitchReasonToolBoundary StreamSwitchReason = "tool_boundary"
	// StreamSwitchReasonNoToolsCompletion indicates switch at stream end without tools.
	StreamSwitchReasonNoToolsCompletion StreamSwitchReason = "no_tools_completion"
)

// MeridianStreamSwitchEvent is sent when an interjection is injected and streaming
// switches to a new assistant turn. Frontend should:
// 1. Merge userTurn and assistantTurn into store
// 2. Update streamingTurnId/streamingUrl
// 3. Abort current SSE connection to trigger reconnect
type MeridianStreamSwitchEvent struct {
	Type                string             `json:"type"`
	PrevAssistantTurnID string             `json:"prevAssistantTurnId"` // Turn that was streaming
	Reason              StreamSwitchReason `json:"reason"`              // Why switch happened
	UserTurn            any                `json:"userTurn"`            // Persisted user turn (interjection)
	AssistantTurn       any                `json:"assistantTurn"`       // New streaming assistant turn
	StreamURL           string             `json:"streamUrl"`           // URL for new SSE stream
}

// NewMeridianStreamSwitchEvent creates a STREAM_SWITCH event.
func NewMeridianStreamSwitchEvent(
	prevAssistantTurnID string,
	reason StreamSwitchReason,
	userTurn any,
	assistantTurn any,
	streamURL string,
) *MeridianStreamSwitchEvent {
	return &MeridianStreamSwitchEvent{
		Type:                MeridianEventTypeStreamSwitch,
		PrevAssistantTurnID: prevAssistantTurnID,
		Reason:              reason,
		UserTurn:            userTurn,
		AssistantTurn:       assistantTurn,
		StreamURL:           streamURL,
	}
}
