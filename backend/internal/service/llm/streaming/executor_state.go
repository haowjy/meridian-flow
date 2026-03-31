package streaming

import "fmt"

// ExecutorState represents the state of the StreamExecutor state machine.
// Streaming transitions are handled by the streaming goroutine; Terminate can
// transition directly to terminal states for pre-start/fail-fast paths.
type ExecutorState int

const (
	// StateNotStarted is the initial state before workFunc begins execution.
	// This closes the pre-start window where an executor is registered but not yet running.
	StateNotStarted ExecutorState = iota

	// StateStreaming is the active state where blocks are persisted and stream events are sent.
	StateStreaming

	// StateDrainMetadata is entered after soft cancel. Event emission is stopped, but provider stream
	// continues in background to capture final token metadata.
	StateDrainMetadata

	// StateHardCancelled is entered when context is cancelled (hard cancel).
	// No further processing occurs.
	StateHardCancelled

	// StateTimedOut is entered when soft cancel timeout fires before provider finishes.
	// Tokens are counted from the cancel snapshot.
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
	case StateNotStarted:
		return "NotStarted"
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

// IsTerminal returns true when the executor has already reached a terminal state.
func (s ExecutorState) IsTerminal() bool {
	switch s {
	case StateCompleted, StateErrored, StateTimedOut, StateHardCancelled:
		return true
	default:
		return false
	}
}

// AllowsPersistence returns true if blocks should be persisted in this state.
func (s ExecutorState) AllowsPersistence() bool {
	return s == StateStreaming
}

// AllowsStreamEvents returns true if stream events should be sent in this state.
func (s ExecutorState) AllowsStreamEvents() bool {
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
