package streaming

import "fmt"

// ExecutorState represents the state of the StreamExecutor state machine.
// Only the streaming goroutine transitions between states.
type ExecutorState int

const (
	// StateStreaming is the initial state where blocks are persisted and SSE events are sent.
	StateStreaming ExecutorState = iota

	// StateDrainMetadata is entered after soft cancel. SSE is stopped, but provider stream
	// continues in background to capture final token metadata.
	StateDrainMetadata

	// StateHardCancelled is entered when context is cancelled (hard cancel).
	// No further processing occurs.
	StateHardCancelled

	// StateTimedOut is entered when soft cancel timeout fires before provider finishes.
	// Tokens are estimated from the cancel snapshot.
	//
	// TODO(observability): Emit a structured metric/log/event for this transition so we can
	// alert on providers that frequently fail to send final metadata within the drain window.
	StateTimedOut

	// StateCompleted is the terminal state for successful completion.
	StateCompleted

	// StateErrored is the terminal state for errors.
	StateErrored
)

// String returns a human-readable name for the state.
func (s ExecutorState) String() string {
	switch s {
	case StateStreaming:
		return "Streaming"
	case StateDrainMetadata:
		return "DrainMetadata"
	case StateHardCancelled:
		return "HardCancelled"
	case StateTimedOut:
		return "TimedOut"
	case StateCompleted:
		return "Completed"
	case StateErrored:
		return "Errored"
	default:
		return fmt.Sprintf("Unknown(%d)", s)
	}
}

// IsTerminal returns true if this is a terminal state (no further transitions possible).
func (s ExecutorState) IsTerminal() bool {
	return s == StateCompleted || s == StateErrored
}

// AllowsPersistence returns true if blocks should be persisted in this state.
func (s ExecutorState) AllowsPersistence() bool {
	return s == StateStreaming
}

// AllowsSSE returns true if SSE events should be sent in this state.
func (s ExecutorState) AllowsSSE() bool {
	return s == StateStreaming
}

// ControlCmd represents commands that can be sent to the executor via ctrlCh.
type ControlCmd int

const (
	// CmdSoftCancel requests soft cancellation (hard-like UX, background metadata drain).
	CmdSoftCancel ControlCmd = iota

	// CmdHardCancel requests hard cancellation (immediate context cancel).
	CmdHardCancel
)

// String returns a human-readable name for the command.
func (c ControlCmd) String() string {
	switch c {
	case CmdSoftCancel:
		return "SoftCancel"
	case CmdHardCancel:
		return "HardCancel"
	default:
		return fmt.Sprintf("Unknown(%d)", c)
	}
}

// controlMsg is the message type sent through the control channel.
type controlMsg struct {
	cmd ControlCmd
}
