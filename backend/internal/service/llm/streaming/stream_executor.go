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
	stream     *mstream.Stream
	turnID     string
	model      string
	turnWriter domainllm.TurnWriter // Only needs write operations (ISP compliance)
	provider   domainllm.LLMProvider
	logger     *slog.Logger
	req        *domainllm.GenerateRequest // Stored for WorkFunc to use

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

	// Actor pattern state management
	// Only the streaming goroutine transitions state; others send commands via ctrlCh.
	state   ExecutorState   // Current state (only streaming goroutine mutates)
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

	// Cleanup callback - called when streaming completes/errors
	// Used by service layer to clean up executor registry
	onCleanup func()

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
	// Buffer is managed by the service layer, accessed here for injection points.
	interjectionBuffer mstream.InterjectionBuffer
	streamSwitchFn     StreamSwitchFn // Callback to create new turns when injecting interjection
}

// StreamSwitchFn is called when an interjection triggers a stream switch.
// It creates a new user turn (with interjection content) and a new assistant turn,
// then starts streaming for the new assistant turn.
// Returns the created turns and the URL for the new stream.
type StreamSwitchFn func(ctx context.Context, currentAssistantTurnID string, interjection string, reason string) (*StreamSwitchResult, error)

// StreamSwitchResult contains the newly created turns from an interjection injection.
type StreamSwitchResult struct {
	UserTurn      any    // The persisted user turn containing the interjection
	AssistantTurn any    // The new assistant turn (streaming)
	StreamURL     string // URL for the new SSE stream
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
// Accepts minimal interfaces for better ISP compliance: TurnWriter for writes, TurnReader for block reads and catchup
func NewStreamExecutor(
	turnID string,
	threadID string, // Thread ID for AG-UI events
	userID string, // User who initiated this turn (for tool provenance)
	model string,
	turnWriter domainllm.TurnWriter,
	turnReader domainllm.TurnReader,
	turnNavigator domainllm.TurnNavigator,
	provider domainllm.LLMProvider,
	toolRegistry *tools.ToolRegistry,
	messageBuilder domainllm.MessageBuilder,
	logger *slog.Logger,
	creditAdmissionChecker billing.CreditAdmissionChecker,
	creditSettler billing.CreditSettler,
	settlementMode billing.CreditSettlementMode,
	maxToolRounds int,
	debugMode bool,
	tokenFinalizer tokens.TokenFinalizer,
	jobQueue jobs.JobQueue,
	softCancelTimeoutSeconds int,
	interjectionBuffer mstream.InterjectionBuffer, // For buffering user interjections during streaming
	streamSwitchFn StreamSwitchFn, // Callback for creating new turns on interjection injection
) *StreamExecutor {
	// Create AG-UI IDFactory for stable ID generation
	idFactory := agui.NewIDFactory(turnID, threadID)

	se := &StreamExecutor{
		turnID:                 turnID,
		threadID:               threadID,
		userID:                 userID,
		model:                  model,
		turnWriter:             turnWriter,
		provider:               provider,
		logger:                 logger,
		toolRegistry:           toolRegistry,
		turnNavigator:          turnNavigator,
		turnReader:             turnReader,
		messageBuilder:         messageBuilder,
		toolResultIDs:          make(map[string]bool),
		toolIteration:          0,
		requestIndex:           0, // Initial request (increments with each tool continuation)
		creditAdmissionChecker: creditAdmissionChecker,
		creditSettler:          creditSettler,
		settlementMode:         settlementMode,
		maxToolRounds:          maxToolRounds,
		maxBlockSequence:       -1, // No blocks persisted yet (so first block is sequence 0)
		state:                  StateStreaming,
		ctrlCh:                 make(chan controlMsg, 1), // Buffered for non-blocking sends
		tokenFinalizer:         tokenFinalizer,
		jobQueue:               jobQueue,
		softCancelTimeout:      time.Duration(softCancelTimeoutSeconds) * time.Second,
		persistenceGuard:       NewPersistenceGuard(), // Armed initially, disarmed on cancel
		idFactory:              idFactory,             // AG-UI ID generation
		interjectionBuffer:     interjectionBuffer,    // For user interjections
		streamSwitchFn:         streamSwitchFn,        // For stream switch on interjection
		// aguiEmitter initialized in workFunc when send function is available

		toolCallParentMessageIDs: make(map[string]string),
		lastAssistantMessageID:   "",
	}

	// Create catchup function for database-backed event replay (needs TurnReader)
	catchupFunc := buildCatchupFunc(turnReader, logger)

	// Create mstream.Stream with WorkFunc, catchup support, and optional event IDs (DEBUG mode)
	stream := mstream.NewStream(
		turnID,
		se.workFunc,
		mstream.WithCatchup(catchupFunc),
		mstream.WithEventIDs(debugMode), // Enable event IDs only in DEBUG mode
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
func (se *StreamExecutor) SetCleanupCallback(fn func()) {
	se.onCleanup = fn
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
		se.handleError(ctx, send, fmt.Errorf("failed to start provider streaming: %w", err))
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
					se.transitionTo(StateHardCancelled)

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
							// We want to stop the stream immediately (done above via state transition)
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
					se.handleError(ctx, send, err)
					return err
				}
			}

		case <-ctx.Done():
			// Context cancelled - handle graceful shutdown
			se.transitionTo(StateErrored)
			err := fmt.Errorf("streaming interrupted: %w", ctx.Err())
			se.handleError(ctx, send, err)
			return err

		case streamEvent, ok := <-streamChan:
			if !ok {
				// Stream channel closed without metadata - unexpected
				se.transitionTo(StateErrored)
				err := fmt.Errorf("stream closed without metadata")
				se.handleError(ctx, send, err)
				return err
			}

			// Check for errors
			if streamEvent.Error != nil {
				se.transitionTo(StateErrored)
				se.handleError(ctx, send, streamEvent.Error)
				return streamEvent.Error
			}

			// Process AG-UI events (new protocol path)
			// AG-UI events are forwarded directly to SSE - they are self-contained and protocol-compliant
			if streamEvent.HasAGUIEvent() {
				if err := se.processAGUIEvent(ctx, send, streamEvent.AGUIEvent, &currentBlockIndex, streamStartSequence); err != nil {
					se.transitionTo(StateErrored)
					se.handleError(ctx, send, err)
					return err
				}
			}

			// NOTE: Legacy Delta events are no longer processed - AG-UI events handle streaming display

			// Process complete block (for database persistence)
			if streamEvent.Block != nil {
				if err := se.processCompleteBlock(ctx, send, streamEvent.Block, streamStartSequence); err != nil {
					se.transitionTo(StateErrored)
					se.handleError(ctx, send, err)
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
