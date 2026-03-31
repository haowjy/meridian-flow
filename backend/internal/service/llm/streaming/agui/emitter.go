package agui

import (
	"encoding/json"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// Emitter serializes AG-UI events and sends them via mstream.
// It provides a bridge between the library's AG-UI events and backend stream transport.
//
// AG-UI Event Format:
//
//	event: TEXT_MESSAGE_CONTENT
//	data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_xxx","delta":"Hello"}
//
// Usage:
//
//	emitter := NewEmitter(send, idFactory, logger)
//	emitter.EmitAGUIEvent(textContentEvent)  // Sends formatted SSE
type Emitter struct {
	send      func(mstream.Event)
	idFactory *IDFactory
	logger    *slog.Logger
}

// NewEmitter creates a new Emitter for sending AG-UI events via SSE.
func NewEmitter(send func(mstream.Event), idFactory *IDFactory, logger *slog.Logger) *Emitter {
	return &Emitter{
		send:      send,
		idFactory: idFactory,
		logger:    logger,
	}
}

// EmitAGUIEvent serializes an AG-UI event and sends it via mstream.
func (e *Emitter) EmitAGUIEvent(evt events.Event) error {
	if evt == nil {
		return fmt.Errorf("cannot emit nil AG-UI event")
	}

	// Get event type for event field
	eventType := string(evt.Type())

	// Serialize full event to JSON
	data, err := json.Marshal(evt)
	if err != nil {
		e.logger.Error("failed to marshal AG-UI event",
			"event_type", eventType,
			"error", err,
		)
		return fmt.Errorf("marshal AG-UI event: %w", err)
	}

	// Create mstream event with AG-UI event type and JSON data
	event := mstream.NewEvent(data).WithType(eventType)
	e.send(event)

	return nil
}

// emitMeridianEvent serializes a Meridian-extended event and sends it via mstream.
// This is similar to EmitAGUIEvent but works with our custom event structs
// that don't implement the events.Event interface.
func (e *Emitter) emitMeridianEvent(eventType string, evt any) error {
	if evt == nil {
		return fmt.Errorf("cannot emit nil Meridian event")
	}

	// Serialize event to JSON
	data, err := json.Marshal(evt)
	if err != nil {
		e.logger.Error("failed to marshal Meridian event",
			"event_type", eventType,
			"error", err,
		)
		return fmt.Errorf("marshal Meridian event: %w", err)
	}

	// Create mstream event with AG-UI event type and JSON data
	event := mstream.NewEvent(data).WithType(eventType)
	e.send(event)

	return nil
}

// EmitRunStarted sends a RUN_STARTED event at the beginning of streaming.
// This signals to the frontend that a new run/turn has begun.
//
// lastBlockSequence is optional:
//   - nil on first connection (no blocks exist yet)
//   - pointer to last persisted sequence on reconnection (for block index continuity)
func (e *Emitter) EmitRunStarted(lastBlockSequence *int) {
	threadID := e.idFactory.ThreadID()
	runID := e.idFactory.RunID()
	turnID := e.idFactory.TurnID()

	// Use Meridian-extended event with lastBlockSequence for reconnection support
	evt := NewMeridianRunStartedEvent(threadID, runID, turnID, lastBlockSequence)
	if err := e.emitMeridianEvent(string(evt.Type), evt); err != nil {
		e.logger.Warn("failed to emit RUN_STARTED",
			"turn_id", turnID,
			"error", err,
		)
	}
}

// EmitRunFinished sends a RUN_FINISHED event on successful completion.
// This signals that the turn completed without errors.
//
// Includes LLM metadata: stopReason, inputTokens, outputTokens.
func (e *Emitter) EmitRunFinished(stopReason string, inputTokens, outputTokens int) {
	threadID := e.idFactory.ThreadID()
	runID := e.idFactory.RunID()
	turnID := e.idFactory.TurnID()

	// Use Meridian-extended event with LLM metadata
	evt := NewMeridianRunFinishedEvent(threadID, runID, turnID, stopReason, inputTokens, outputTokens)
	if err := e.emitMeridianEvent(string(evt.Type), evt); err != nil {
		e.logger.Warn("failed to emit RUN_FINISHED",
			"turn_id", turnID,
			"error", err,
		)
	}
}

// EmitRunError sends a RUN_ERROR event on failure or cancellation.
// This signals that the turn encountered an error or was cancelled.
//
// isCancelled distinguishes user cancellation from actual errors:
//   - true: User cancelled streaming, don't show error toast in UI
//   - false: Actual error occurred, show error toast
func (e *Emitter) EmitRunError(errMsg string, isCancelled bool) {
	threadID := e.idFactory.ThreadID()
	runID := e.idFactory.RunID()
	turnID := e.idFactory.TurnID()

	// Use Meridian-extended event with cancellation flag
	evt := NewMeridianRunErrorEvent(threadID, runID, turnID, errMsg, isCancelled)
	if err := e.emitMeridianEvent(string(evt.Type), evt); err != nil {
		e.logger.Warn("failed to emit RUN_ERROR",
			"turn_id", turnID,
			"original_error", errMsg,
			"emit_error", err,
		)
	}
}

// EmitCreditsExhausted sends a CREDITS_EXHAUSTED event and leaves run finalization
// to the caller (typically followed by RUN_FINISHED with credits_exhausted stop reason).
func (e *Emitter) EmitCreditsExhausted(requestIndex int, phase string) {
	threadID := e.idFactory.ThreadID()
	runID := e.idFactory.RunID()
	turnID := e.idFactory.TurnID()

	evt := NewMeridianCreditsExhaustedEvent(threadID, runID, turnID, requestIndex, phase)
	if err := e.emitMeridianEvent(MeridianEventTypeCreditsExhausted, evt); err != nil {
		e.logger.Warn("failed to emit CREDITS_EXHAUSTED",
			"turn_id", turnID,
			"request_index", requestIndex,
			"phase", phase,
			"error", err,
		)
	}
}

// EmitStepStarted sends a STEP_STARTED event at the beginning of an LLM request.
// Useful for tracking individual requests in tool continuation loops.
func (e *Emitter) EmitStepStarted() {
	stepName := e.idFactory.StepName()

	evt := events.NewStepStartedEvent(stepName)
	if err := e.EmitAGUIEvent(evt); err != nil {
		e.logger.Warn("failed to emit STEP_STARTED",
			"turn_id", e.idFactory.TurnID(),
			"step_name", stepName,
			"error", err,
		)
	}
}

// EmitStepFinished sends a STEP_FINISHED event at the end of an LLM request.
func (e *Emitter) EmitStepFinished() {
	stepName := e.idFactory.StepName()

	evt := events.NewStepFinishedEvent(stepName)
	if err := e.EmitAGUIEvent(evt); err != nil {
		e.logger.Warn("failed to emit STEP_FINISHED",
			"turn_id", e.idFactory.TurnID(),
			"step_name", stepName,
			"error", err,
		)
	}
}

// EmitToolCallResult sends a TOOL_CALL_RESULT event for a completed tool invocation.
//
// contentJSON must be a JSON-encoded string. Keeping this API string-based avoids
// double-encoding and keeps the caller responsible for choosing the payload shape.
func (e *Emitter) EmitToolCallResult(messageID, toolCallID, contentJSON string) {
	if messageID == "" || toolCallID == "" {
		e.logger.Warn("skipping TOOL_CALL_RESULT (missing ids)",
			"turn_id", e.idFactory.TurnID(),
			"message_id", messageID,
			"tool_call_id", toolCallID,
		)
		return
	}

	evt := events.NewToolCallResultEvent(messageID, toolCallID, contentJSON)
	if err := e.EmitAGUIEvent(evt); err != nil {
		e.logger.Warn("failed to emit TOOL_CALL_RESULT",
			"turn_id", e.idFactory.TurnID(),
			"message_id", messageID,
			"tool_call_id", toolCallID,
			"error", err,
		)
	}
}

// IDFactory returns the underlying IDFactory for ID generation.
func (e *Emitter) IDFactory() *IDFactory {
	return e.idFactory
}
