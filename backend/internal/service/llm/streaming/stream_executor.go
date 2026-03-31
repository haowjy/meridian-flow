package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	mstream "github.com/haowjy/meridian-stream-go"

	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/streaming/agui"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
)

// dbWriteDeadline is the maximum time to wait for database writes during cleanup.
// This prevents the executor from blocking forever if the database is slow or unresponsive.
// Used in cancel/timeout paths where we use context.Background() to ensure cleanup
// completes even if the original context is cancelled.
const dbWriteDeadline = 30 * time.Second

// StreamExecutor wraps mstream.Stream and manages LLM streaming for a turn.
// It adapts the existing TurnExecutor logic to work with mstream's architecture.
// Complete blocks come from the library (already normalized), so no accumulation needed.
type StreamExecutor struct {
	stream       *mstream.Stream
	turnID       string
	projectID    string
	model        string
	providerName string
	turnWriter   domainllm.TurnWriter // Only needs write operations (ISP compliance)
	provider     domainllm.LLMProvider
	logger       *slog.Logger
	req          *domainllm.GenerateRequest // Stored for WorkFunc to use

	// Tool execution support
	toolRegistry     *tools.ToolRegistry
	turnNavigator    domainllm.TurnNavigator  // For loading conversation path during continuation
	turnReader       domainllm.TurnReader     // For loading turn blocks during continuation
	messageBuilder   domainllm.MessageBuilder // For building messages from conversation history
	collectedTools   []tools.ToolCall         // tool_use blocks collected during streaming
	toolResultIDs    map[string]bool          // tool_use_ids that already have tool_results (from provider decode errors)
	toolIteration    int                      // current tool round (0 = initial, 1+ = continuations)
	requestIndex     int                      // current LLM request index (0 = initial, 1+ = continuations)
	maxToolRounds    int                      // maximum number of tool execution rounds (default: 5)
	maxBlockSequence int                      // highest block sequence number persisted (for tool_result sequencing)

	// Accumulator state for partial block persistence on interruption
	// NOTE: Legacy SSE block events have been removed - AG-UI handles streaming display.
	// These accumulators are still used for:
	// - textAccumulator: Partial text block persistence on cancel/error
	// - blockTypes: Block type tracking for partial persistence filtering
	// - jsonAccumulator: Cleanup reference (no longer actively used for events)
	jsonAccumulator map[int]string // blockIndex -> accumulated JSON (cleanup only)
	textAccumulator map[int]string // blockIndex -> accumulated text
	blockTypes      map[int]string // blockIndex -> block type (for filtering on persistence)

	// Actor pattern state management.
	// The streaming goroutine handles in-flight transitions; Terminate can move
	// directly to terminal states for pre-start and fail-fast paths.
	state   ExecutorState   // Current state (protected by stateMu)
	stateMu sync.RWMutex    // Protects state reads from other goroutines
	ctrlCh  chan controlMsg // Command channel for cancel requests (buffered, size 1)

	// Token finalization (replaces scattered token logic)
	tokenFinalizer tokens.TokenFinalizer

	// Billing collaborators (non-optional: use explicit noop implementations in dev/test).
	creditAdmissionChecker billing.CreditAdmissionChecker
	creditSettler          billing.CreditSettler
	settlementMode         billing.CreditSettlementMode

	// Phase 2: Background job queue for async generation enrichment
	jobQueue jobs.JobQueue // nil for non-OpenRouter deployments

	// Soft cancel timeout: if provider doesn't finish within this duration after cancel,
	// force cleanup and count tokens from the snapshot taken at cancel time.
	softCancelTimeout  time.Duration // Timeout duration (from config, default: 5 minutes)
	cancelTextSnapshot string        // Text accumulated at the moment of cancel (for timeout token counting)

	// OpenRouter generation ID: captured from streaming metadata for token finalization
	generationID string       // Captured from streaming metadata (OpenRouter only)
	generationMu sync.RWMutex // Protects generationID (read by timeout goroutine)

	// Persistence guard: atomic flag to prevent race condition where cancel is
	// requested but block persistence is already in PersistAndClear callback.
	// Disarmed IMMEDIATELY on cancel request, before queueing command.
	persistenceGuard *PersistenceGuard

	// Cleanup callback - called when terminalization completes.
	// Used by service layer to clean up executor registry
	onCleanup func(reason TerminateReason)
	cleanupMu sync.Mutex

	// Stream slot release callback is separated from registry cleanup so stream
	// switch can transfer slot ownership to a new executor.
	releaseStreamSlot func()
	slotReleaseMu     sync.Mutex

	// Token budget monitor — checks context usage after turn completion and
	// triggers autocollapse/autocompact. nil when monitoring is disabled.
	tokenMonitor *TokenMonitor

	// Identity: who triggered this stream (for provenance tracking in tool execution)
	userID string // User who initiated this streaming turn

	// AG-UI Protocol Support
	// These enable the new AG-UI streaming protocol alongside legacy events (dual protocol mode)
	threadID    string          // Thread/conversation ID for AG-UI events
	idFactory   *agui.IDFactory // Generates stable IDs for AG-UI events
	aguiEmitter *agui.Emitter   // Serializes and sends AG-UI events via SSE

	// Tool call correlation for backend-emitted AG-UI TOOL_CALL_RESULT.
	// ToolCallStartEvent provides parentMessageId; we persist that mapping so tool results
	// can be emitted with a stable messageId.
	toolCallParentMessageIDs map[string]string // toolCallId -> parentMessageId
	lastAssistantMessageID   string            // fallback for missing parentMessageId

	// Interjection support: allows users to inject messages during streaming.
	// Router is managed by the service layer and coordinates drain points.
	interjectionRouter InterjectionRouter
	streamRuntime      *StreamRuntime // Runtime reference for first-class stream switching
}

// TerminateReason describes why a stream is ending.
type TerminateReason int

const (
	// ReasonCompleted is normal completion (stop_reason != tool_use).
	ReasonCompleted TerminateReason = iota

	// ReasonSoftCancelDrained means provider metadata arrived after soft cancel.
	ReasonSoftCancelDrained

	// ReasonHardCancelled is an immediate hard cancellation.
	ReasonHardCancelled

	// ReasonSoftCancelTimeout means soft-cancel drain timed out.
	ReasonSoftCancelTimeout

	// ReasonError is a non-cancellation terminal failure.
	ReasonError

	// ReasonCreditsExhausted is terminal admission denial for insufficient credits.
	ReasonCreditsExhausted

	// ReasonStreamSwitch ends the current stream because a new stream takes over.
	ReasonStreamSwitch
)

// String returns a human-readable reason name.
func (r TerminateReason) String() string {
	switch r {
	case ReasonCompleted:
		return "completed"
	case ReasonSoftCancelDrained:
		return "soft_cancel_drained"
	case ReasonHardCancelled:
		return "hard_cancelled"
	case ReasonSoftCancelTimeout:
		return "soft_cancel_timeout"
	case ReasonError:
		return "error"
	case ReasonCreditsExhausted:
		return "credits_exhausted"
	case ReasonStreamSwitch:
		return "stream_switch"
	default:
		return fmt.Sprintf("unknown(%d)", r)
	}
}

// TerminalState returns the terminal executor state for the reason.
func (r TerminateReason) TerminalState() ExecutorState {
	switch r {
	case ReasonHardCancelled:
		return StateHardCancelled
	case ReasonSoftCancelTimeout:
		return StateTimedOut
	case ReasonError:
		return StateErrored
	default:
		return StateCompleted
	}
}

// ShouldPersistPartials reports whether accumulated partial blocks should be persisted.
func (r TerminateReason) ShouldPersistPartials() bool {
	switch r {
	case ReasonHardCancelled, ReasonError, ReasonCreditsExhausted:
		return true
	default:
		return false
	}
}

// ShouldFinalizeTokens reports whether token finalization should run.
// Stream switch is conditional: finalization runs only if metadata is provided.
func (r TerminateReason) ShouldFinalizeTokens() bool {
	switch r {
	case ReasonCompleted, ReasonSoftCancelDrained, ReasonHardCancelled, ReasonSoftCancelTimeout, ReasonError, ReasonStreamSwitch:
		return true
	default:
		return false
	}
}

// ShouldSettleBilling reports whether billing settlement should run.
// Stream switch is conditional: settlement runs only if metadata/tokens are available.
func (r TerminateReason) ShouldSettleBilling() bool {
	switch r {
	case ReasonCompleted, ReasonSoftCancelDrained, ReasonHardCancelled, ReasonSoftCancelTimeout, ReasonError, ReasonStreamSwitch:
		return true
	default:
		return false
	}
}

// TerminateOpts carries reason-specific inputs for Terminate.
type TerminateOpts struct {
	// Metadata from provider completion paths.
	Metadata *domainllm.StreamMetadata

	// ErrorMessage for error and cancellation terminal events.
	ErrorMessage string

	// StopReason for completion run-finished events.
	StopReason string

	// RequestIndex identifies which provider request was denied for credits.
	RequestIndex int

	// Phase identifies the denied phase (initial/tool_continue/graceful_completion).
	Phase string
}

// StreamExecutorConfig groups constructor inputs to avoid brittle positional args.
type StreamExecutorConfig struct {
	// Identity and request context.
	TurnID       string
	ThreadID     string
	UserID       string
	ProjectID    string
	Model        string
	ProviderName string

	// Core collaborators.
	TurnWriter     domainllm.TurnWriter
	TurnReader     domainllm.TurnReader
	TurnNavigator  domainllm.TurnNavigator
	Provider       domainllm.LLMProvider
	ToolRegistry   *tools.ToolRegistry
	MessageBuilder domainllm.MessageBuilder
	Logger         *slog.Logger

	// Billing/token lifecycle.
	CreditAdmissionChecker billing.CreditAdmissionChecker
	CreditSettler          billing.CreditSettler
	SettlementMode         billing.CreditSettlementMode
	TokenFinalizer         tokens.TokenFinalizer

	// Runtime behavior.
	MaxToolRounds            int
	DebugMode                bool
	JobQueue                 jobs.JobQueue
	SoftCancelTimeoutSeconds int

	// Interjection routing.
	InterjectionRouter InterjectionRouter
	StreamRuntime      *StreamRuntime
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
// Accepts minimal interfaces for better ISP compliance: TurnWriter for writes, TurnReader for block reads and catchup.
func NewStreamExecutor(cfg StreamExecutorConfig) *StreamExecutor {
	_ = cfg.DebugMode // Event IDs are always enabled in mstream.

	// Create AG-UI IDFactory for stable ID generation
	idFactory := agui.NewIDFactory(cfg.TurnID, cfg.ThreadID)

	se := &StreamExecutor{
		turnID:                 cfg.TurnID,
		threadID:               cfg.ThreadID,
		userID:                 cfg.UserID,
		projectID:              cfg.ProjectID,
		model:                  cfg.Model,
		providerName:           cfg.ProviderName,
		turnWriter:             cfg.TurnWriter,
		provider:               cfg.Provider,
		logger:                 cfg.Logger,
		toolRegistry:           cfg.ToolRegistry,
		turnNavigator:          cfg.TurnNavigator,
		turnReader:             cfg.TurnReader,
		messageBuilder:         cfg.MessageBuilder,
		toolResultIDs:          make(map[string]bool),
		toolIteration:          0,
		requestIndex:           0, // Initial request (increments with each tool continuation)
		creditAdmissionChecker: cfg.CreditAdmissionChecker,
		creditSettler:          cfg.CreditSettler,
		settlementMode:         cfg.SettlementMode,
		maxToolRounds:          cfg.MaxToolRounds,
		maxBlockSequence:       -1, // No blocks persisted yet (so first block is sequence 0)
		state:                  StateNotStarted,
		ctrlCh:                 make(chan controlMsg, 1), // Buffered for non-blocking sends
		tokenFinalizer:         cfg.TokenFinalizer,
		jobQueue:               cfg.JobQueue,
		softCancelTimeout:      time.Duration(cfg.SoftCancelTimeoutSeconds) * time.Second,
		persistenceGuard:       NewPersistenceGuard(),  // Armed initially, disarmed on cancel
		idFactory:              idFactory,              // AG-UI ID generation
		interjectionRouter:     cfg.InterjectionRouter, // For user interjections
		streamRuntime:          cfg.StreamRuntime,      // For stream switch on interjection
		// aguiEmitter initialized in workFunc when send function is available

		toolCallParentMessageIDs: make(map[string]string),
		lastAssistantMessageID:   "",
	}

	// Create catchup function for database-backed event replay (needs TurnReader)
	catchupFunc := buildCatchupFunc(cfg.TurnReader, cfg.Logger)

	// Create mstream.Stream with WorkFunc and catchup support.
	stream := mstream.NewStream(
		cfg.TurnID,
		se.workFunc,
		mstream.WithCatchup(catchupFunc),
	)
	se.stream = stream

	return se
}

// GetStream returns the underlying mstream.Stream
func (se *StreamExecutor) GetStream() *mstream.Stream {
	return se.stream
}

// getState returns the current executor state (thread-safe for reads from other goroutines).
func (se *StreamExecutor) getState() ExecutorState {
	se.stateMu.RLock()
	defer se.stateMu.RUnlock()
	return se.state
}

// transitionTo changes the executor state. Only call from the streaming goroutine.
// Logs the transition for debugging.
func (se *StreamExecutor) transitionTo(newState ExecutorState) {
	oldState := se.state
	se.stateMu.Lock()
	se.state = newState
	se.stateMu.Unlock()

	se.logger.Debug("executor state transition",
		"turn_id", se.turnID,
		"from", oldState.String(),
		"to", newState.String(),
	)
}

// SetCleanupCallback sets a function to be called when streaming completes or errors.
// Used by service layer to clean up executor registry.
func (se *StreamExecutor) SetCleanupCallback(fn func(reason TerminateReason)) {
	se.cleanupMu.Lock()
	defer se.cleanupMu.Unlock()
	se.onCleanup = fn
}

// SetSlotRelease sets the stream-slot release callback used at terminal cleanup.
func (se *StreamExecutor) SetSlotRelease(fn func()) {
	se.slotReleaseMu.Lock()
	defer se.slotReleaseMu.Unlock()
	se.releaseStreamSlot = fn
}

// TransferSlotRelease detaches and returns the slot-release callback so another
// executor can inherit slot ownership during stream switch.
func (se *StreamExecutor) TransferSlotRelease() func() {
	se.slotReleaseMu.Lock()
	defer se.slotReleaseMu.Unlock()
	release := se.releaseStreamSlot
	se.releaseStreamSlot = nil
	return release
}

// Terminate is the single terminalization entry point for executor shutdown.
// It is idempotent and safe to call before workFunc starts.
func (se *StreamExecutor) Terminate(reason TerminateReason, opts TerminateOpts) {
	terminalState := reason.TerminalState()

	// Idempotency guard with atomic check+transition under lock.
	se.stateMu.Lock()
	currentState := se.state
	if currentState.IsTerminal() {
		se.stateMu.Unlock()
		se.logger.Debug("Terminate no-op (already terminal)",
			"turn_id", se.turnID,
			"state", currentState.String(),
			"reason", reason.String(),
		)
		return
	}
	se.state = terminalState
	se.stateMu.Unlock()

	se.logger.Debug("executor state transition",
		"turn_id", se.turnID,
		"from", currentState.String(),
		"to", terminalState.String(),
	)

	// DB writes in termination must outlive cancelled streaming contexts.
	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Step 1: Persist partial blocks.
	if reason.ShouldPersistPartials() {
		se.persistPartialBlocks(persistCtx)
	}

	// Step 2: Finalize tokens.
	var tokenResult *tokens.TokenResult
	if reason.ShouldFinalizeTokens() {
		tokenResult = se.finalizeTokensForTermination(persistCtx, reason, opts.Metadata)
	}

	// Step 3: Settle billing.
	if reason.ShouldSettleBilling() {
		se.settleBillingForTermination(persistCtx, reason, opts.Metadata, tokenResult)
	}

	// Step 4: Mark turn status.
	se.markTurnStatusForTermination(persistCtx, reason, opts.ErrorMessage)

	// Step 5: Emit terminal AG-UI event.
	se.emitTerminalEventForTermination(reason, opts, tokenResult)

	// Step 6: Registry cleanup + slot release.
	se.cleanupMu.Lock()
	onCleanup := se.onCleanup
	se.cleanupMu.Unlock()
	if onCleanup != nil {
		onCleanup(reason)
	}

	slotRelease := se.TransferSlotRelease()
	if slotRelease != nil {
		slotRelease()
	}
}

func (se *StreamExecutor) finalizeTokensForTermination(
	ctx context.Context,
	reason TerminateReason,
	metadata *domainllm.StreamMetadata,
) *tokens.TokenResult {
	if reason == ReasonStreamSwitch && metadata == nil {
		// Tool-boundary stream switches have no new metadata to finalize.
		return nil
	}

	if metadata != nil {
		if metadata.Model == "" {
			metadata.Model = se.model
		}
		if metadata.GenerationID != "" {
			se.setGenerationID(metadata.GenerationID)
		}
	}

	finalizeReason, ok := tokenFinalizeReasonForTerminate(reason)
	if !ok || se.tokenFinalizer == nil {
		if metadata != nil {
			se.persistCompletionMetadataForTerminate(ctx, metadata)
		}
		return nil
	}

	cancelSnapshot := ""
	switch reason {
	case ReasonHardCancelled, ReasonError:
		cancelSnapshot = se.getAccumulatedText()
		if cancelSnapshot == "" {
			cancelSnapshot = se.cancelTextSnapshot
		}
	case ReasonSoftCancelTimeout, ReasonSoftCancelDrained:
		cancelSnapshot = se.cancelTextSnapshot
	}

	var providerTokens *tokens.ProviderTokens
	if metadata != nil {
		providerTokens = &tokens.ProviderTokens{
			InputTokens:  metadata.InputTokens,
			OutputTokens: metadata.OutputTokens,
		}
	}

	model := se.model
	if metadata != nil && metadata.Model != "" {
		model = metadata.Model
	}

	result, err := se.tokenFinalizer.Finalize(ctx, tokens.FinalizeRequest{
		TurnID:         se.turnID,
		Model:          model,
		GenerationID:   se.getGenerationID(),
		CancelSnapshot: cancelSnapshot,
		Reason:         finalizeReason,
		ProviderTokens: providerTokens,
	})
	if err != nil {
		se.logger.Warn("failed to finalize tokens during termination",
			"turn_id", se.turnID,
			"reason", reason.String(),
			"error", err,
		)
		if metadata != nil {
			se.persistCompletionMetadataForTerminate(ctx, metadata)
		}
		return nil
	}

	if metadata != nil {
		metadata.InputTokens = result.InputTokens
		metadata.OutputTokens = result.OutputTokens
		se.persistCompletionMetadataForTerminate(ctx, metadata)
		return result
	}

	if err := se.persistTokenMetadata(ctx, result, tokenPersistReasonForTerminate(reason)); err != nil {
		se.logger.Warn("failed to persist finalized tokens during termination",
			"turn_id", se.turnID,
			"reason", reason.String(),
			"error", err,
		)
	}

	return result
}

func (se *StreamExecutor) persistCompletionMetadataForTerminate(ctx context.Context, metadata *domainllm.StreamMetadata) {
	if metadata == nil {
		return
	}

	if err := se.updateTurnMetadata(ctx, metadata); err != nil {
		se.logger.Warn("failed to persist turn metadata during termination",
			"turn_id", se.turnID,
			"reason", metadata.StopReason,
			"error", err,
		)
	}

	if err := se.persistGenerationRecord(ctx, metadata); err != nil {
		se.logger.Warn("failed to persist generation record during termination",
			"turn_id", se.turnID,
			"generation_id", se.getGenerationID(),
			"error", err,
		)
	}
}

func (se *StreamExecutor) settleBillingForTermination(
	ctx context.Context,
	reason TerminateReason,
	metadata *domainllm.StreamMetadata,
	tokenResult *tokens.TokenResult,
) {
	if reason == ReasonStreamSwitch && metadata == nil {
		// Tool-boundary stream switch path already settled in prior completion.
		return
	}

	pendingReason := pendingSettlementReasonForTerminate(reason)
	isCancelled := isCancelledTerminateReason(reason)

	settlementMetadata := metadata
	if settlementMetadata == nil && tokenResult != nil && (tokenResult.InputTokens > 0 || tokenResult.OutputTokens > 0) {
		settlementMetadata = &domainllm.StreamMetadata{
			Model:        se.model,
			InputTokens:  tokenResult.InputTokens,
			OutputTokens: tokenResult.OutputTokens,
		}
	}

	if settlementMetadata != nil {
		if settlementMetadata.Model == "" {
			settlementMetadata.Model = se.model
		}
		se.handleFinalSettlement(ctx, settlementMetadata, pendingReason, isCancelled)
		return
	}

	if se.settlementMode != billing.CreditSettlementDeferredToEnrichment {
		return
	}

	if generationID := se.getGenerationID(); generationID != "" {
		phase := "initial"
		if se.requestIndex > 0 {
			phase = "tool_continue"
		}
		se.enqueueEnrichmentSettlementJob(generationID, phase, se.model, isCancelled)
	}
	se.persistCurrentRequestPendingSettlement(ctx, se.model, pendingReason)
}

func (se *StreamExecutor) markTurnStatusForTermination(ctx context.Context, reason TerminateReason, errorMessage string) {
	switch reason {
	case ReasonCompleted, ReasonStreamSwitch:
		if err := se.turnWriter.UpdateTurnStatus(ctx, se.turnID, domainllm.TurnStatusComplete, nil); err != nil {
			se.logger.Warn("failed to mark turn complete during termination",
				"turn_id", se.turnID,
				"reason", reason.String(),
				"error", err,
			)
		}
	case ReasonError:
		userErrorMsg := "Provider request failed"
		if errorMessage != "" {
			userErrorMsg = sanitizeProviderError(fmt.Errorf("%s", errorMessage))
		}
		if err := se.turnWriter.UpdateTurnError(ctx, se.turnID, userErrorMsg); err != nil {
			se.logger.Warn("failed to mark turn error during termination",
				"turn_id", se.turnID,
				"error", err,
			)
		}
	case ReasonCreditsExhausted:
		se.markTurnCreditLimited(ctx)
	case ReasonSoftCancelDrained, ReasonHardCancelled, ReasonSoftCancelTimeout:
		// Exception: InterruptTurn writes cancelled status from a different goroutine
		// (outside Terminate) before the streaming actor drains/stops.
		// Keep this branch as a no-op so we don't race/override that status write.
	}
}

func (se *StreamExecutor) markTurnCreditLimited(ctx context.Context) {
	completedAt := time.Now().UTC()
	turn, err := se.turnReader.GetTurn(ctx, se.turnID)
	if err != nil {
		se.logger.Warn("failed to load turn while marking credit_limited",
			"turn_id", se.turnID,
			"error", err,
		)
		fallback := &domainllm.Turn{CompletedAt: &completedAt}
		if statusErr := se.turnWriter.UpdateTurnStatus(ctx, se.turnID, domainllm.TurnStatusCreditLimited, fallback); statusErr != nil {
			se.logger.Warn("failed to mark turn credit_limited",
				"turn_id", se.turnID,
				"error", statusErr,
			)
		}
		return
	}

	turn.Status = domainllm.TurnStatusCreditLimited
	turn.CompletedAt = &completedAt
	turn.Error = ptrString(creditLimitedErrorMessage)
	if updateErr := se.turnWriter.UpdateTurn(ctx, turn); updateErr != nil {
		se.logger.Warn("failed to persist credit_limited turn state",
			"turn_id", se.turnID,
			"error", updateErr,
		)
	}
}

func (se *StreamExecutor) emitTerminalEventForTermination(
	reason TerminateReason,
	opts TerminateOpts,
	tokenResult *tokens.TokenResult,
) {
	if se.aguiEmitter == nil {
		return
	}

	switch reason {
	case ReasonCompleted:
		stopReason := opts.StopReason
		if stopReason == "" && opts.Metadata != nil {
			stopReason = opts.Metadata.StopReason
		}

		inputTokens, outputTokens := 0, 0
		if opts.Metadata != nil {
			inputTokens = opts.Metadata.InputTokens
			outputTokens = opts.Metadata.OutputTokens
		} else if tokenResult != nil {
			inputTokens = tokenResult.InputTokens
			outputTokens = tokenResult.OutputTokens
		}

		se.aguiEmitter.EmitStepFinished()
		se.aguiEmitter.EmitRunFinished(stopReason, inputTokens, outputTokens)
	case ReasonSoftCancelDrained:
		// Soft-cancel drained path already disconnected clients; no terminal event here.
	case ReasonHardCancelled:
		msg := opts.ErrorMessage
		if msg == "" {
			msg = "cancelled"
		}
		se.aguiEmitter.EmitRunError(msg, true)
	case ReasonSoftCancelTimeout:
		msg := opts.ErrorMessage
		if msg == "" {
			msg = "timeout waiting for provider metadata"
		}
		se.aguiEmitter.EmitRunError(msg, true)
	case ReasonError:
		msg := "Provider request failed"
		if opts.ErrorMessage != "" {
			msg = sanitizeProviderError(fmt.Errorf("%s", opts.ErrorMessage))
		}
		se.aguiEmitter.EmitRunError(msg, false)
	case ReasonCreditsExhausted:
		requestIndex := opts.RequestIndex
		phase := opts.Phase
		if phase == "" && requestIndex == 0 && se.requestIndex > 0 {
			requestIndex = se.requestIndex
		}
		if phase == "" {
			phase = "initial"
			if requestIndex > 0 {
				phase = "tool_continue"
			}
		}
		se.aguiEmitter.EmitCreditsExhausted(requestIndex, phase)
		se.aguiEmitter.EmitRunFinished(runStopReasonCreditsExhausted, 0, 0)
	case ReasonStreamSwitch:
		// Stream switch handoff metadata is emitted before Terminate.
	}
}

func tokenFinalizeReasonForTerminate(reason TerminateReason) (tokens.FinalizeReason, bool) {
	switch reason {
	case ReasonCompleted, ReasonStreamSwitch:
		return tokens.ReasonCompletion, true
	case ReasonSoftCancelDrained:
		return tokens.ReasonSoftCancel, true
	case ReasonHardCancelled:
		return tokens.ReasonHardCancel, true
	case ReasonSoftCancelTimeout:
		return tokens.ReasonSoftCancelTimeout, true
	case ReasonError:
		return tokens.ReasonError, true
	default:
		return "", false
	}
}

func tokenPersistReasonForTerminate(reason TerminateReason) string {
	switch reason {
	case ReasonSoftCancelTimeout:
		return "soft_cancel_timeout"
	case ReasonHardCancelled, ReasonError:
		return "interrupted_stream"
	default:
		return reason.String()
	}
}

func pendingSettlementReasonForTerminate(reason TerminateReason) string {
	switch reason {
	case ReasonSoftCancelTimeout:
		return "soft_cancel_timeout"
	case ReasonHardCancelled, ReasonError:
		return "interrupted_stream"
	default:
		return "awaiting_enrichment"
	}
}

func isCancelledTerminateReason(reason TerminateReason) bool {
	switch reason {
	case ReasonSoftCancelDrained, ReasonHardCancelled, ReasonSoftCancelTimeout:
		return true
	default:
		return false
	}
}

// Start begins streaming execution
func (se *StreamExecutor) Start(req *domainllm.GenerateRequest) {
	// Store request for WorkFunc to use
	se.req = req

	// Start the stream
	se.stream.Start()
}

// workFunc is the mstream WorkFunc that performs the actual streaming
func (se *StreamExecutor) workFunc(ctx context.Context, send func(mstream.Event)) error {
	// A pre-start Terminate can happen before Start() is invoked by the background runtime
	// goroutine. Never resurrect terminal executors back into Streaming.
	se.stateMu.Lock()
	currentState := se.state
	if currentState.IsTerminal() {
		se.stateMu.Unlock()
		se.logger.Debug("workFunc start skipped (already terminal)",
			"turn_id", se.turnID,
			"state", currentState.String(),
		)
		return nil
	}

	// Guarantee: if workFunc exits for ANY reason and state is not terminal,
	// Terminate runs. This is the structural fix — no more whack-a-mole.
	defer func() {
		se.stateMu.RLock()
		finalState := se.state
		isTerminal := finalState.IsTerminal()
		se.stateMu.RUnlock()
		if !isTerminal {
			se.logger.Warn("workFunc exited without termination, running cleanup",
				"turn_id", se.turnID,
				"state", finalState.String(),
			)
			se.Terminate(ReasonError, TerminateOpts{ErrorMessage: "workFunc exited without terminal state"})
		}
	}()

	se.state = StateStreaming
	se.stateMu.Unlock()

	se.logger.Debug("executor state transition",
		"turn_id", se.turnID,
		"from", currentState.String(),
		"to", StateStreaming.String(),
	)

	// Use the stored GenerateRequest
	req := se.req
	if req == nil {
		return fmt.Errorf("generate request not set")
	}

	// Initialize AG-UI emitter with send function (available only in workFunc)
	// This enables AG-UI event emission for the duration of streaming
	se.aguiEmitter = agui.NewEmitter(send, se.idFactory, se.logger)

	// Emit AG-UI RUN_STARTED event at the beginning of streaming
	// This signals to AG-UI compliant frontends that a new run has begun
	// For first connection (workFunc), lastBlockSequence is nil (no blocks yet)
	// Reconnection uses catchup which includes lastBlockSequence
	se.aguiEmitter.EmitRunStarted(nil)

	// Step-level admission gate (belt-and-suspenders with HTTP middleware).
	// IMPORTANT: Denied initial requests must not emit STEP_STARTED and must not mark turn streaming.
	if err := se.creditAdmissionChecker.CheckAdmission(ctx, se.userID); err != nil {
		se.logger.Warn("credit admission denied before initial provider call",
			"turn_id", se.turnID,
			"user_id", se.userID,
			"request_index", se.requestIndex,
			"phase", "initial",
			"error", err,
		)
		se.handleCreditsExhausted(ctx, send, se.requestIndex, "initial")
		return nil
	}

	// Update turn status to "streaming"
	// NOTE: Turn stays "streaming" through all continuation rounds.
	// Only marked "complete" when handleCompletion receives stop_reason != "tool_use"
	if err := se.turnWriter.UpdateTurnStatus(ctx, se.turnID, domainllm.TurnStatusStreaming, nil); err != nil {
		return fmt.Errorf("failed to update turn status: %w", err)
	}

	se.aguiEmitter.EmitStepStarted() // Initial LLM request step

	// NOTE: turn_start (event-0) is emitted by catchup function, not here
	// Live streaming starts with block events (event-1+)

	// Start provider streaming
	streamChan, err := se.startProviderStreamWithRetry(ctx, req)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to start provider streaming: %w", err), false)
		return err
	}

	// Delegate to stream processor (reusable for continuation)
	return se.processProviderStream(ctx, streamChan, send)
}

func (se *StreamExecutor) startProviderStreamWithRetry(
	ctx context.Context,
	req *domainllm.GenerateRequest,
) (<-chan domainllm.StreamEvent, error) {
	var lastErr error

	for attempt := 1; attempt <= providerStartMaxAttempts; attempt++ {
		streamChan, err := se.provider.StreamResponse(ctx, req)
		if err == nil {
			return streamChan, nil
		}

		lastErr = err
		if attempt >= providerStartMaxAttempts || !isRetryableProviderStartError(err) {
			return nil, err
		}

		se.logger.Warn("provider stream start failed; retrying",
			"turn_id", se.turnID,
			"attempt", attempt,
			"max_attempts", providerStartMaxAttempts,
			"retry_delay", providerStartRetryDelay,
			"error", err,
		)

		retryTimer := time.NewTimer(providerStartRetryDelay)
		select {
		case <-ctx.Done():
			retryTimer.Stop()
			return nil, ctx.Err()
		case <-retryTimer.C:
		}
	}

	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("failed to start provider stream")
}

// processProviderStream processes streaming events from the provider.
// This function can be called recursively for tool continuation.
func (se *StreamExecutor) processProviderStream(
	ctx context.Context,
	streamChan <-chan domainllm.StreamEvent,
	send func(mstream.Event),
) error {
	// CRITICAL: Track where this stream starts for sequence remapping
	// Provider always emits block indices starting at 0, but continuation streams
	// need to continue from where we left off (after tool_result blocks)
	// Initial stream: maxBlockSequence = -1, streamStartSequence = 0
	// Continuation: maxBlockSequence = 2, streamStartSequence = 3
	streamStartSequence := se.maxBlockSequence + 1

	// Track current block index for delta events (-1 means no block started yet)
	currentBlockIndex := -1

	// Drain timeout is only used after soft cancel (DrainMetadata).
	// We intentionally do not treat "no provider bytes" as an error during normal streaming,
	// because long-running tool execution/subagents can legitimately pause provider output for a long time.
	var drainTimer *time.Timer
	var drainTimerCh <-chan time.Time
	defer func() {
		if drainTimer != nil {
			drainTimer.Stop()
		}
	}()

	// Keep-alive ticker to prevent frontend from appearing frozen
	// Sends SSE comments every 5 seconds while waiting for provider events
	keepAliveTicker := time.NewTicker(5 * time.Second)
	defer keepAliveTicker.Stop()

	for {
		select {
		case <-keepAliveTicker.C:
			// Send keep-alive event to prevent connection timeout
			// Frontend ignores events without recognized types
			// This keeps the HTTP connection alive during long provider response times
			keepAliveData := []byte("{}")
			send(mstream.NewEvent(keepAliveData).WithType("keepalive"))

		case <-drainTimerCh:
			// Drain timeout after soft cancel - force cleanup and count tokens.
			// handleTimeoutInStreamingGoroutine transitions to StateErrored and returns error.
			return se.handleTimeoutInStreamingGoroutine(send)

		case cmd := <-se.ctrlCh:
			// Handle control commands from service layer
			switch cmd.cmd {
			case CmdSoftCancel:
				if se.state == StateStreaming {
					se.transitionTo(StateDrainMetadata)
					se.handleSoftCancel(send)

					// Start drain timeout to prevent leaked executors if provider never finishes.
					if se.softCancelTimeout > 0 && drainTimer == nil {
						drainTimer = time.NewTimer(se.softCancelTimeout)
						drainTimerCh = drainTimer.C
						se.logger.Debug("soft cancel drain timeout started",
							"turn_id", se.turnID,
							"timeout", se.softCancelTimeout,
							"snapshot_length", len(se.cancelTextSnapshot),
						)
					}
				}
			case CmdHardCancel:
				if se.state == StateStreaming || se.state == StateDrainMetadata {
					// Phase 4: Try OpenRouter API cancel (best-effort, upstream-dependent)
					// This attempts to stop the provider's upstream request to reduce billing costs.
					// If the upstream supports cancel: billing stops immediately
					// If the upstream doesn't support cancel: API returns error, we continue anyway
					// We ALWAYS query /generation API later for authoritative token usage (primary goal)
					canceller, ok := se.provider.(domainllm.GenerationCanceller)
					if ok {
						generationID := se.getGenerationID()
						if generationID != "" {
							// Non-blocking: call in background, don't wait for response
							// We want to stop the stream immediately (via hard-cancel termination path below).
							go func() {
								cancelCtx, cancelCancel := context.WithTimeout(context.Background(), 5*time.Second)
								defer cancelCancel()

								if err := canceller.CancelGeneration(cancelCtx, generationID); err != nil {
									se.logger.Warn("OpenRouter cancel API failed (upstream may not support it)",
										"turn_id", se.turnID,
										"generation_id", generationID,
										"error", err,
									)
								} else {
									se.logger.Debug("OpenRouter cancel API succeeded",
										"turn_id", se.turnID,
										"generation_id", generationID,
									)
								}
							}()
						} else {
							se.logger.Debug("cancel before generation ID discovered, skipping API call",
								"turn_id", se.turnID,
							)
						}
					}

					err := fmt.Errorf("hard cancelled by user")
					se.handleError(ctx, send, err, true)
					return err
				}
			}

		case <-ctx.Done():
			// Context cancelled - handle graceful shutdown
			err := fmt.Errorf("streaming interrupted: %w", ctx.Err())
			se.handleError(ctx, send, err, false)
			return err

		case streamEvent, ok := <-streamChan:
			if !ok {
				// Stream channel closed without metadata - unexpected
				err := fmt.Errorf("stream closed without metadata")
				se.handleError(ctx, send, err, false)
				return err
			}

			// Check for errors
			if streamEvent.Error != nil {
				se.handleError(ctx, send, streamEvent.Error, false)
				return streamEvent.Error
			}

			// Process AG-UI events (new protocol path)
			// AG-UI events are forwarded directly to SSE - they are self-contained and protocol-compliant
			if streamEvent.HasAGUIEvent() {
				if err := se.processAGUIEvent(ctx, send, streamEvent.AGUIEvent, &currentBlockIndex, streamStartSequence); err != nil {
					se.handleError(ctx, send, err, false)
					return err
				}
			}

			// NOTE: Legacy Delta events are no longer processed - AG-UI events handle streaming display

			// Process complete block (for database persistence)
			if streamEvent.Block != nil {
				if err := se.processCompleteBlock(ctx, send, streamEvent.Block, streamStartSequence); err != nil {
					se.handleError(ctx, send, err, false)
					return err
				}
			}

			// Process early generation ID discovery (for partial record persistence)
			if streamEvent.GenerationIDDiscovered != nil {
				if err := se.processGenerationIDDiscovered(ctx, streamEvent.GenerationIDDiscovered); err != nil {
					// Don't fail stream - best-effort persistence
					// Log warning and continue streaming
					se.logger.Warn("failed to persist early generation ID",
						"turn_id", se.turnID,
						"generation_id", streamEvent.GenerationIDDiscovered.GenerationID,
						"error", err,
					)
				}
			}

			// Process metadata (final event)
			if streamEvent.Metadata != nil {
				return se.handleCompletion(ctx, send, streamEvent.Metadata)
			}
		}
	}
}

// logContinuationRequest logs detailed information about the continuation request
// to help diagnose 400 errors from OpenRouter.
func (se *StreamExecutor) logContinuationRequest(req *domainllm.GenerateRequest) {
	// NOTE: Do not log full request JSON here. It may contain user content, tool inputs,
	// and other large payloads that clutter logs and risk leaking sensitive text.
	se.logger.Debug("continuation request structure",
		"message_count", len(req.Messages),
		"model", req.Model,
	)

	// Log each message's structure (roles and block types)
	for i, msg := range req.Messages {
		blockTypes := make([]string, len(msg.Content))
		for j, block := range msg.Content {
			blockTypes[j] = block.BlockType
		}
		se.logger.Debug("continuation message",
			"index", i,
			"role", msg.Role,
			"block_count", len(msg.Content),
			"block_types", blockTypes,
		)
	}
}
