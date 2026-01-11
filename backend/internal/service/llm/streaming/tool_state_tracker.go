package streaming

import (
	"sync"
	"time"

	llmModels "meridian/internal/domain/models/llm"
)

// ToolStreamState represents the current state of a streaming tool.
// Used for tracking state and deciding when to emit SSE events.
type ToolStreamState struct {
	ToolName  string
	ToolUseID string
	State     string // ToolStatePreparing, ToolStateReady, ToolStateExecuting (see sse_events.go)
	Input     map[string]interface{}
}

// ToolStateTracker manages tool streaming state and throttles SSE emissions.
// SRP: Only manages state and throttling, no extraction/emission logic.
// Thread-safe: Uses mutex for concurrent access from streaming goroutine.
type ToolStateTracker struct {
	mu       sync.RWMutex
	states   map[int]*ToolStreamState // blockIndex -> state
	lastEmit map[int]time.Time        // blockIndex -> last emit time
	throttle time.Duration
}

// NewToolStateTracker creates a tracker with the specified throttle interval.
// Throttle interval determines minimum time between SSE events for the same block.
// Recommended: 100ms to prevent flooding clients while maintaining responsiveness.
func NewToolStateTracker(throttle time.Duration) *ToolStateTracker {
	return &ToolStateTracker{
		states:   make(map[int]*ToolStreamState),
		lastEmit: make(map[int]time.Time),
		throttle: throttle,
	}
}

// UpdateState updates the state for a block and returns true if an SSE event should be emitted.
// Implements throttling to prevent excessive events during rapid JSON delta streaming.
// State transitions (preparing -> ready, preparing -> executing) always emit immediately.
func (t *ToolStateTracker) UpdateState(blockIndex int, state *ToolStreamState) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	oldState := t.states[blockIndex]
	t.states[blockIndex] = state

	// State transitions always emit (e.g., preparing -> ready, preparing -> executing)
	if oldState != nil && oldState.State != state.State {
		t.lastEmit[blockIndex] = time.Now()
		return true
	}

	// For "preparing" state, apply throttling to prevent flooding
	if t.throttle > 0 && state.State == llmModels.ToolStatePreparing {
		if last, ok := t.lastEmit[blockIndex]; ok {
			if time.Since(last) < t.throttle {
				return false // Throttled
			}
		}
	}

	t.lastEmit[blockIndex] = time.Now()
	return true
}

// GetState returns the current state for a block, or nil if not tracked.
func (t *ToolStateTracker) GetState(blockIndex int) *ToolStreamState {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if state, ok := t.states[blockIndex]; ok {
		// Return a copy to avoid data races
		stateCopy := *state
		if state.Input != nil {
			stateCopy.Input = make(map[string]interface{}, len(state.Input))
			for k, v := range state.Input {
				stateCopy.Input[k] = v
			}
		}
		return &stateCopy
	}
	return nil
}

// Clear removes state for a block (call on block_stop or cleanup).
func (t *ToolStateTracker) Clear(blockIndex int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.states, blockIndex)
	delete(t.lastEmit, blockIndex)
}

// ClearAll removes all tracked state (call on turn completion or cleanup).
func (t *ToolStateTracker) ClearAll() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.states = make(map[int]*ToolStreamState)
	t.lastEmit = make(map[int]time.Time)
}
