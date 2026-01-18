package agui

import (
	"fmt"
	"sync"
)

// IDFactory generates deterministic, stable IDs for AG-UI events.
// AG-UI protocol requires consistent IDs for correlation (e.g., messageId for TEXT_MESSAGE_CONTENT).
//
// ID lifecycle:
//   - RunID: "run_{turnID}" - stable for the entire turn (across tool continuations)
//   - MessageID: "msg_{turnID}_{stepIdx}" - unique per LLM request (text message)
//   - ThinkingMessageID: "thinking_{turnID}_{stepIdx}" - unique per LLM request (thinking)
//   - StepName: "llm_request_{stepIdx}" - human-readable step identifier
//
// Thread safety: All methods are safe for concurrent use.
type IDFactory struct {
	turnID   string
	threadID string
	stepIdx  int        // Increments for each LLM request in tool loop
	mu       sync.Mutex // Protects stepIdx
}

// NewIDFactory creates a new IDFactory for a turn.
// turnID: unique turn identifier (e.g., UUID)
// threadID: thread/conversation identifier (e.g., UUID)
func NewIDFactory(turnID, threadID string) *IDFactory {
	return &IDFactory{
		turnID:   turnID,
		threadID: threadID,
		stepIdx:  0, // First LLM request
	}
}

// RunID returns the run identifier, stable for the entire turn.
// Format: "run_{turnID}"
func (f *IDFactory) RunID() string {
	return fmt.Sprintf("run_%s", f.turnID)
}

// ThreadID returns the thread identifier.
func (f *IDFactory) ThreadID() string {
	return f.threadID
}

// TurnID returns the turn identifier.
func (f *IDFactory) TurnID() string {
	return f.turnID
}

// StepName returns a human-readable step identifier for the current LLM request.
// Format: "llm_request_{stepIdx}"
func (f *IDFactory) StepName() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fmt.Sprintf("llm_request_%d", f.stepIdx)
}

// StepIdx returns the current step index.
func (f *IDFactory) StepIdx() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stepIdx
}

// IncrementStep advances to the next LLM request (for tool continuation loops).
// Called after tool execution, before the next provider request.
func (f *IDFactory) IncrementStep() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stepIdx++
}

// MessageID returns the message ID for text messages.
// Format: "msg_{turnID}_{stepIdx}"
// Unique per LLM request, allowing frontend to track which messages belong to which request.
func (f *IDFactory) MessageID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fmt.Sprintf("msg_%s_%d", f.turnID, f.stepIdx)
}

// ThinkingMessageID returns the message ID for thinking/reasoning content.
// Format: "thinking_{turnID}_{stepIdx}"
// Separate from MessageID to allow distinct tracking of thinking vs. response content.
func (f *IDFactory) ThinkingMessageID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fmt.Sprintf("thinking_%s_%d", f.turnID, f.stepIdx)
}

// ToolCallID returns a tool call ID for tracking tool invocations.
// Note: Tool call IDs typically come from the provider (e.g., "toolu_xxx"),
// but this method provides a fallback or can be used for backend-generated tool calls.
// Format: "tool_{turnID}_{stepIdx}_{index}"
func (f *IDFactory) ToolCallID(index int) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fmt.Sprintf("tool_%s_%d_%d", f.turnID, f.stepIdx, index)
}
