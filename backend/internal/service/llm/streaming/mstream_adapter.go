package streaming

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	domainllm "meridian/internal/domain/services/llm"
	"meridian/internal/jobs"
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
	stream   *mstream.Stream
	turnID   string
	model    string
	turnRepo llmRepo.TurnWriter // Only needs write operations (ISP compliance)
	provider domainllm.LLMProvider
	logger   *slog.Logger
	req      *domainllm.GenerateRequest // Stored for WorkFunc to use

	// Tool execution support
	toolRegistry     *tools.ToolRegistry
	turnNavigator    llmRepo.TurnNavigator    // For loading conversation path during continuation
	turnReader       llmRepo.TurnReader       // For loading turn blocks during continuation
	messageBuilder   domainllm.MessageBuilder // For building messages from conversation history
	collectedTools   []tools.ToolCall         // tool_use blocks collected during streaming
	toolResultIDs    map[string]bool          // tool_use_ids that already have tool_results (from provider decode errors)
	toolIteration    int                      // current tool round (0 = initial, 1+ = continuations)
	requestIndex     int                      // current LLM request index (0 = initial, 1+ = continuations)
	maxToolRounds    int                      // maximum number of tool execution rounds (default: 5)
	maxBlockSequence int                      // highest block sequence number persisted (for tool_result sequencing)

	// JSON delta accumulation (for complete block deltas)
	// Partial JSON deltas are useless - accumulate and send complete JSON once
	jsonAccumulator map[int]string // blockIndex -> accumulated JSON

	// Text delta accumulation (for partial block persistence on interruption)
	// Text deltas are sent immediately to SSE, but also accumulated here in case of interruption
	textAccumulator map[int]string // blockIndex -> accumulated text
	blockTypes      map[int]string // blockIndex -> block type (for filtering on persistence)

	// Actor pattern state management
	// Only the streaming goroutine transitions state; others send commands via ctrlCh.
	state   ExecutorState   // Current state (only streaming goroutine mutates)
	stateMu sync.RWMutex    // Protects state reads from other goroutines
	ctrlCh  chan controlMsg // Command channel for cancel requests (buffered, size 1)

	// Token finalization (replaces scattered token logic)
	tokenFinalizer tokens.TokenFinalizer

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

	// Tool streaming state components (SOLID: SRP - separate extraction and state tracking)
	toolInputExtractor *ToolInputExtractor // Extracts fields from partial JSON
	toolStateTracker   *ToolStateTracker   // Manages state and throttles SSE emissions

	// Track current tool metadata per block (needed for tool_input_update events)
	currentToolMeta map[int]toolMeta // providerBlockIndex -> tool metadata

	// Track tool_use_id to block sequence mapping (for tool_executing events)
	toolUseIDToSequence map[string]int // tool_use_id -> block sequence
}

// toolMeta holds tool metadata for a streaming block
type toolMeta struct {
	toolName  string
	toolUseID string
}

// NewStreamExecutor creates a new mstream-based executor for a turn.
// Accepts minimal interfaces for better ISP compliance: TurnWriter for writes, TurnReader for block reads and catchup
func NewStreamExecutor(
	turnID string,
	model string,
	turnWriter llmRepo.TurnWriter,
	turnReader llmRepo.TurnReader,
	turnNavigator llmRepo.TurnNavigator,
	provider domainllm.LLMProvider,
	toolRegistry *tools.ToolRegistry,
	messageBuilder domainllm.MessageBuilder,
	logger *slog.Logger,
	maxToolRounds int,
	debugMode bool,
	tokenFinalizer tokens.TokenFinalizer,
	jobQueue jobs.JobQueue, // NEW: Phase 2 parameter
	softCancelTimeoutSeconds int,
) *StreamExecutor {
	se := &StreamExecutor{
		turnID:              turnID,
		model:               model,
		turnRepo:            turnWriter,
		provider:            provider,
		logger:              logger,
		toolRegistry:        toolRegistry,
		turnNavigator:       turnNavigator,
		turnReader:          turnReader,
		messageBuilder:      messageBuilder,
		toolResultIDs:       make(map[string]bool),
		toolIteration:       0,
		requestIndex:        0, // Initial request (increments with each tool continuation)
		maxToolRounds:       maxToolRounds,
		maxBlockSequence:    -1, // No blocks persisted yet (so first block is sequence 0)
		state:               StateStreaming,
		ctrlCh:              make(chan controlMsg, 1), // Buffered for non-blocking sends
		tokenFinalizer:      tokenFinalizer,
		jobQueue:            jobQueue, // NEW: Phase 2 field
		softCancelTimeout:   time.Duration(softCancelTimeoutSeconds) * time.Second,
		persistenceGuard:    NewPersistenceGuard(), // Armed initially, disarmed on cancel
		toolInputExtractor:  NewToolInputExtractor(),
		toolStateTracker:    NewToolStateTracker(100 * time.Millisecond), // 100ms throttle
		currentToolMeta:     make(map[int]toolMeta),
		toolUseIDToSequence: make(map[string]int),
	}

	// Create catchup function for database-backed event replay (needs TurnReader)
	serializer := llmModels.NewBlockSerializer()
	catchupFunc := buildCatchupFunc(turnReader, serializer, logger)

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

// RequestSoftCancel requests a "hard-like" cancel UX while allowing the provider stream
// to continue in background for accurate final token metadata.
//
// This sends a command to the streaming goroutine via ctrlCh. The streaming goroutine
// will persist partial text blocks, emit a cancellation SSE event, then disconnect clients.
//
// Idempotent: multiple calls are safe (buffered channel drops duplicates).
func (se *StreamExecutor) RequestSoftCancel() {
	// CRITICAL: Disarm persistence guard FIRST for immediate visibility.
	// This prevents the race condition where cancel is requested but
	// PersistAndClear callback has already passed the state check.
	// The atomic store is immediately visible to all goroutines.
	se.persistenceGuard.Disarm()

	select {
	case se.ctrlCh <- controlMsg{cmd: CmdSoftCancel}:
		se.logger.Debug("soft cancel command queued", "turn_id", se.turnID)
	default:
		// Channel full - cancel already requested (idempotent)
		se.logger.Debug("soft cancel command already queued (idempotent)", "turn_id", se.turnID)
	}
}

// RequestHardCancel requests immediate cancellation (for Anthropic models that support it).
// This sends a command to the streaming goroutine which will cancel the context.
func (se *StreamExecutor) RequestHardCancel() {
	// CRITICAL: Disarm persistence guard FIRST for immediate visibility.
	// Same protection as RequestSoftCancel - prevents race condition.
	se.persistenceGuard.Disarm()

	select {
	case se.ctrlCh <- controlMsg{cmd: CmdHardCancel}:
		se.logger.Debug("hard cancel command queued", "turn_id", se.turnID)
	default:
		// Channel full - cancel already requested (idempotent)
		se.logger.Debug("hard cancel command already queued (idempotent)", "turn_id", se.turnID)
	}
}

// handleTimeoutInStreamingGoroutine processes the timeout command.
// MUST be called from the streaming goroutine to preserve actor pattern.
// Returns an error to signal the streaming loop should exit.
func (se *StreamExecutor) handleTimeoutInStreamingGoroutine(send func(mstream.Event)) error {
	// Only process timeout if we're still draining metadata
	if se.state != StateDrainMetadata {
		se.logger.Debug("timeout command ignored (not in DrainMetadata state)",
			"turn_id", se.turnID,
			"current_state", se.state.String(),
		)
		return nil
	}

	// Transition to TimedOut state
	se.transitionTo(StateTimedOut)

	// CRITICAL: Cancel the provider stream to stop the HTTP connection.
	// Without this, the provider keeps streaming (goroutine leak + billing).
	se.stream.Cancel()

	se.logger.Warn("soft cancel timeout fired, forcing cleanup",
		"turn_id", se.turnID,
		"timeout", se.softCancelTimeout,
		"generation_id", se.getGenerationID(),
		"snapshot_length", len(se.cancelTextSnapshot),
	)

	// Use deadline to prevent blocking if DB is slow/unresponsive
	ctx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Use TokenFinalizer to get best-effort tokens
	if se.tokenFinalizer != nil {
		result, err := se.tokenFinalizer.Finalize(ctx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          se.model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: se.cancelTextSnapshot,
			Reason:         tokens.ReasonSoftCancelTimeout,
			ProviderTokens: nil, // No provider tokens on timeout
		})
		if err != nil {
			se.logger.Warn("token finalization failed on timeout",
				"turn_id", se.turnID,
				"error", err,
			)
		} else if updateErr := se.persistTokenMetadata(ctx, result, "soft_cancel_timeout"); updateErr != nil {
			se.logger.Warn("failed to save tokens on timeout",
				"turn_id", se.turnID,
				"error", updateErr,
			)
		}
	}

	// Transition to Errored state (terminal)
	se.transitionTo(StateErrored)

	// Send error event to any remaining clients
	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:      se.turnID,
		Error:       "timeout waiting for provider metadata",
		IsCancelled: true, // Timeout after cancel is still a cancel
	})

	// Cleanup executor
	if se.onCleanup != nil {
		se.onCleanup()
	}

	// Return error to exit streaming loop
	return fmt.Errorf("soft cancel timeout")
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

	// Update turn status to "streaming"
	// NOTE: Turn stays "streaming" through all continuation rounds.
	// Only marked "complete" when handleCompletion receives stop_reason != "tool_use"
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "streaming", nil); err != nil {
		return fmt.Errorf("failed to update turn status: %w", err)
	}

	// NOTE: turn_start (event-0) is emitted by catchup function, not here
	// Live streaming starts with block events (event-1+)

	// Start provider streaming
	streamChan, err := se.provider.StreamResponse(ctx, req)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to start provider streaming: %w", err))
		return err
	}

	// Delegate to stream processor (reusable for continuation)
	return se.processProviderStream(ctx, streamChan, send)
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

			// Process delta (for real-time UI updates)
			if streamEvent.Delta != nil {
				if err := se.processDelta(ctx, send, streamEvent.Delta, &currentBlockIndex, streamStartSequence); err != nil {
					se.transitionTo(StateErrored)
					se.handleError(ctx, send, err)
					return err
				}
			}

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

// processDelta handles a single TurnBlockDelta for real-time UI updates.
// - Text/signature deltas are sent immediately (useful for progressive display)
// - JSON deltas are accumulated (partial JSON is unparseable/useless, send complete JSON later)
// - Text deltas are also accumulated for partial block persistence on interruption
// streamStartSequence is used to remap provider block indices to turn-level sequences
func (se *StreamExecutor) processDelta(_ context.Context, send func(mstream.Event), delta *llmModels.TurnBlockDelta, currentBlockIndex *int, streamStartSequence int) error {
	// After soft cancel (DrainMetadata state), we keep draining the provider stream for metadata,
	// but we stop emitting SSE events and stop accumulating deltas.
	if !se.state.AllowsSSE() {
		return nil
	}

	// Detect new block start
	if delta.BlockIndex != *currentBlockIndex {
		// CRITICAL: Remap provider block index to turn-level sequence for SSE event
		// Provider always sends indices 0, 1, 2... but continuation streams need 3, 4, 5...
		turnLevelSequence := streamStartSequence + delta.BlockIndex

		// Send block_start for new block (including tool metadata for tool_use blocks)
		se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
			BlockIndex: turnLevelSequence,
			BlockType:  delta.BlockType,
			ToolName:   delta.ToolCallName, // NEW: Tool name for progressive display
			ToolUseID:  delta.ToolCallID,   // NEW: Tool use ID for correlation
		})

		// Track tool metadata for this block (needed for tool_input_update events)
		if delta.ToolCallName != nil && delta.ToolCallID != nil {
			se.currentToolMeta[delta.BlockIndex] = toolMeta{
				toolName:  *delta.ToolCallName,
				toolUseID: *delta.ToolCallID,
			}
		}

		// Track block type for partial block persistence (only text blocks are persisted)
		if delta.BlockType != nil {
			if se.blockTypes == nil {
				se.blockTypes = make(map[int]string)
			}
			se.blockTypes[delta.BlockIndex] = *delta.BlockType
		}

		*currentBlockIndex = delta.BlockIndex
	}

	// Accumulate JSON deltas and emit tool_input_update events for progressive display
	// NOTE: Use provider's block index as map key (not remapped sequence)
	if delta.JSONDelta != nil && *delta.JSONDelta != "" {
		if se.jsonAccumulator == nil {
			se.jsonAccumulator = make(map[int]string)
		}
		se.jsonAccumulator[delta.BlockIndex] += *delta.JSONDelta

		// NEW: Extract fields and emit tool_input_update if we have tool metadata
		if meta, ok := se.currentToolMeta[delta.BlockIndex]; ok {
			accumulated := se.jsonAccumulator[delta.BlockIndex]
			extractedInput := se.toolInputExtractor.Extract(meta.toolName, accumulated)

			state := &ToolStreamState{
				ToolName:  meta.toolName,
				ToolUseID: meta.toolUseID,
				State:     llmModels.ToolStatePreparing,
				Input:     extractedInput,
			}

			// Only emit if not throttled (100ms interval)
			turnLevelSequence := streamStartSequence + delta.BlockIndex
			if se.toolStateTracker.UpdateState(delta.BlockIndex, state) {
				se.sendEvent(send, llmModels.SSEEventToolInputUpdate, llmModels.ToolInputUpdateEvent{
					BlockIndex: turnLevelSequence,
					ToolUseID:  meta.toolUseID,
					ToolName:   meta.toolName, // Always include toolName for frontend display
					State:      llmModels.ToolStatePreparing,
					Input:      extractedInput,
				})
			}
		}

		return nil
	}

	// Accumulate text deltas for partial block persistence on interruption
	// This allows us to save partial text blocks if the stream is interrupted
	if delta.TextDelta != nil && *delta.TextDelta != "" {
		if se.textAccumulator == nil {
			se.textAccumulator = make(map[int]string)
		}
		se.textAccumulator[delta.BlockIndex] += *delta.TextDelta
	}

	// Send text/signature deltas immediately (useful incrementally)
	// CRITICAL: Remap provider block index to turn-level sequence for SSE event
	if delta.DeltaType != "" && (delta.TextDelta != nil || delta.SignatureDelta != nil) {
		turnLevelSequence := streamStartSequence + delta.BlockIndex
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex:     turnLevelSequence,
			DeltaType:      delta.DeltaType,
			TextDelta:      delta.TextDelta,
			SignatureDelta: delta.SignatureDelta,
			JSONDelta:      nil, // Never send partial JSON
		})
	}

	return nil
}

// processCompleteBlock handles a complete, normalized block from the library.
// The library has already normalized provider-specific types (web_search_tool_result → tool_result).
// streamStartSequence is used to remap provider block indices to turn-level sequences
func (se *StreamExecutor) processCompleteBlock(ctx context.Context, send func(mstream.Event), block *llmModels.TurnBlock, streamStartSequence int) error {
	// Set turn ID
	block.TurnID = se.turnID

	// CRITICAL: Save provider's original block index before remapping
	// We need this to access jsonAccumulator (which uses provider indices as keys)
	providerBlockIndex := block.Sequence

	// CRITICAL FIX: Remap provider block index to turn-level sequence
	// Provider always emits blocks starting at index 0 for each stream, but continuation
	// streams need to continue from where we left off (after tool_result blocks)
	// Initial stream: streamStartSequence = 0, provider block 0 → sequence 0
	// Continuation: streamStartSequence = 3, provider block 0 → sequence 3
	block.Sequence = streamStartSequence + providerBlockIndex

	// If not in Streaming state, skip all persistence/tool collection and SSE.
	// Partial text (accumulated before cancel) is persisted by handleSoftCancel().
	if !se.state.AllowsPersistence() {
		// Best-effort cleanup for this block index to avoid unbounded memory growth.
		if se.jsonAccumulator != nil {
			delete(se.jsonAccumulator, providerBlockIndex)
		}
		if se.textAccumulator != nil {
			delete(se.textAccumulator, providerBlockIndex)
		}
		if se.blockTypes != nil {
			delete(se.blockTypes, providerBlockIndex)
		}
		return nil
	}

	// Collect BACKEND-SIDE tool_use blocks for execution (if tool registry is available)
	// Provider-side tools (e.g., Anthropic's built-in web_search) are already executed by the provider
	// Backend-side tools (e.g., Tavily web search, doc_view, doc_tree) need backend execution
	// TODO: Optimization - start executing tools in background goroutine immediately upon collection
	// instead of waiting for stream completion. This would overlap tool execution with provider
	// streaming, reducing total latency. Currently: collect → stream finishes → execute → stream results.
	// Optimized: collect + execute in background → stream finishes → wait for execution → stream results.
	if se.toolRegistry != nil && block.IsBackendSideTool() {
		se.collectToolUse(block)
	}

	// Persist block to database atomically using PersistAndClear
	// NOTE: We intentionally do NOT check ctx.Done() before persisting.
	// Even if context is cancelled (e.g., client disconnect, server shutdown),
	// we want to persist LLM responses to avoid losing data. This ensures
	// graceful shutdown and allows users to retrieve responses later via catchup.
	persisted := false
	if err := se.stream.PersistAndClear(func(events []mstream.Event) error {
		// CRITICAL: Use PersistenceGuard as primary check.
		// The guard is disarmed IMMEDIATELY when cancel is requested (atomic store),
		// so this check is race-free. The state check alone has a race window because
		// state only changes when the select loop processes the command.
		if !se.persistenceGuard.IsArmed() {
			se.logger.Debug("skipping block persistence (guard disarmed)",
				"block_type", block.BlockType,
				"sequence", block.Sequence,
			)
			return nil
		}

		// Belt-and-suspenders: Also check state (should be redundant now)
		if se.getState() != StateStreaming {
			se.logger.Debug("skipping block persistence in callback (not streaming)",
				"block_type", block.BlockType,
				"sequence", block.Sequence,
				"state", se.getState().String(),
			)
			return nil
		}

		// Persist the block to database
		if err := se.turnRepo.CreateTurnBlock(ctx, block); err != nil {
			return fmt.Errorf("create turn block: %w", err)
		}
		persisted = true
		return nil
	}); err != nil {
		return fmt.Errorf("failed to persist block %d: %w", block.Sequence, err)
	}

	// If we didn't persist (due to interruption), clean up and return early without SSE events.
	if !persisted {
		if se.jsonAccumulator != nil {
			delete(se.jsonAccumulator, providerBlockIndex)
		}
		if se.textAccumulator != nil {
			delete(se.textAccumulator, providerBlockIndex)
		}
		if se.blockTypes != nil {
			delete(se.blockTypes, providerBlockIndex)
		}
		return nil
	}

	// Track max sequence for tool_result block sequencing
	if block.Sequence > se.maxBlockSequence {
		se.maxBlockSequence = block.Sequence
	}

	// Track tool_result IDs from provider (e.g., decode error results)
	// This prevents backend from executing tools that already have results
	if block.BlockType == llmModels.BlockTypeToolResult {
		if toolUseID, ok := block.Content["tool_use_id"].(string); ok {
			se.toolResultIDs[toolUseID] = true
		}
	}

	// Send accumulated JSON as complete delta (if any)
	// This provides complete, parseable JSON instead of useless partial fragments
	// NOTE: Use provider's original block index to access jsonAccumulator
	if accumulatedJSON, exists := se.jsonAccumulator[providerBlockIndex]; exists {
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex: block.Sequence, // Use remapped sequence for SSE
			DeltaType:  llmModels.DeltaTypeJSON,
			JSONDelta:  &accumulatedJSON,
		})
		delete(se.jsonAccumulator, providerBlockIndex) // Cleanup using provider index
	}

	// NEW: Send tool_input_update with state="complete" for tool_use blocks
	// This signals that all input has been received and tool is ready for execution
	if meta, ok := se.currentToolMeta[providerBlockIndex]; ok {
		// Extract final input from block content
		var finalInput map[string]interface{}
		if block.Content != nil {
			if input, ok := block.Content["input"].(map[string]interface{}); ok {
				finalInput = input
			}
		}

		se.sendEvent(send, llmModels.SSEEventToolInputUpdate, llmModels.ToolInputUpdateEvent{
			BlockIndex: block.Sequence,
			ToolUseID:  meta.toolUseID,
			ToolName:   meta.toolName, // Always include toolName for frontend display
			State:      llmModels.ToolStateReady,
			Input:      finalInput,
		})

		// Clean up tool state tracker
		se.toolStateTracker.Clear(providerBlockIndex)
		delete(se.currentToolMeta, providerBlockIndex)
	}

	// Clear text accumulator for this completed block (no longer needed for partial persistence)
	if se.textAccumulator != nil {
		delete(se.textAccumulator, providerBlockIndex)
	}
	if se.blockTypes != nil {
		delete(se.blockTypes, providerBlockIndex)
	}

	// Send block_stop event to SSE clients
	se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
		BlockIndex: block.Sequence, // Use remapped sequence for SSE
	})

	se.logger.Debug("persisted complete block",
		"block_index", block.Sequence,
		"block_type", block.BlockType,
		"turn_id", se.turnID,
	)

	return nil
}

// processGenerationIDDiscovered handles early generation ID discovery event.
// This is emitted on the first chunk from the provider, allowing us to persist
// a partial GenerationRecord early in the stream. This enables background
// enrichment even if the stream is cancelled before completion.
//
// This is a non-terminal event - streaming continues after this event.
// Failures are logged but don't stop the stream (best-effort persistence).
func (se *StreamExecutor) processGenerationIDDiscovered(
	ctx context.Context,
	event *domainllm.GenerationIDEvent,
) error {
	// Capture generation ID for later use (thread-safe via mutex)
	// This allows cancel strategies to access the ID when needed
	se.setGenerationID(event.GenerationID)

	// Log discovery for observability
	se.logger.Debug("generation ID discovered",
		"turn_id", se.turnID,
		"generation_id", event.GenerationID,
		"model", event.Model,
		"provider", event.Provider,
		"request_index", se.requestIndex,
		"tool_iteration", se.toolIteration,
	)

	// Determine phase based on tool iteration
	// Initial request: toolIteration = 0, phase = "initial"
	// Tool continuations: toolIteration > 0, phase = "tool_continue"
	phase := "initial"
	if se.toolIteration > 0 {
		phase = "tool_continue"
	}

	// Build partial GenerationRecord (only ID + metadata fields)
	// This will be enriched later via background job when stream completes/cancels
	partialRecord := &llmModels.GenerationRecord{
		ID:           event.GenerationID,
		RequestIndex: se.requestIndex,
		Phase:        phase,
		Model:        event.Model,
		Finalized:    false, // Will be enriched via background job
	}

	// Persist partial record to database (upsert-by-id)
	// If this fails, log but don't stop stream - enrichment can still happen
	// via final metadata event as fallback
	if err := se.turnRepo.AppendGenerationRecord(ctx, se.turnID, partialRecord); err != nil {
		return fmt.Errorf("append partial generation record: %w", err)
	}

	return nil
}

// handleSoftCancel performs "hard-like" cancellation behavior for the client:
// - Persist any accumulated partial text blocks (so refresh shows what user saw)
// - Emit a cancellation SSE event (turn_error with is_cancelled)
// - Disconnect SSE clients via SoftCancel()
//
// The provider stream continues running in the background and will still produce
// final token metadata, which handleCompletion persists even when interrupted.
func (se *StreamExecutor) handleSoftCancel(send func(mstream.Event)) {
	// Use deadline to prevent blocking if DB is slow/unresponsive during partial block persistence
	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Snapshot accumulated text at cancel time for timeout/token counting.
	// IMPORTANT: This must run on the streaming goroutine to avoid concurrent map access.
	if se.cancelTextSnapshot == "" {
		se.cancelTextSnapshot = se.getAccumulatedText()
	}

	// Persist whatever text the user already saw.
	se.persistPartialBlocks(persistCtx)

	// Clear JSON accumulator too (no longer useful after cancel).
	se.jsonAccumulator = nil

	// Tell the frontend to stop streaming immediately (hard-cancel UX).
	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:      se.turnID,
		Error:       "cancelled",
		IsCancelled: true,
	})

	// Disconnect SSE clients. Provider stream continues; executor keeps draining for metadata.
	se.stream.SoftCancel()
}

// handleCompletion handles successful stream completion
func (se *StreamExecutor) handleCompletion(ctx context.Context, send func(mstream.Event), metadata *domainllm.StreamMetadata) error {
	// No need to finalize accumulator - complete blocks are received directly from library
	// and persisted in processCompleteBlock()

	// Use request model as fallback if provider doesn't send it in metadata
	// This prevents validation errors when OpenRouter or other providers omit model in streaming responses
	if metadata.Model == "" {
		metadata.Model = se.model
	}

	// Capture generation ID for potential token stats query on timeout
	// OpenRouter provides this in streaming metadata for querying native token counts
	if metadata.GenerationID != "" {
		se.setGenerationID(metadata.GenerationID)
	}

	// Use TokenFinalizer to get the best available tokens
	// This handles: provider tokens, OpenRouter API fallback, token counter fallback
	currentState := se.getState()
	isDraining := currentState == StateDrainMetadata

	if se.tokenFinalizer != nil {
		var reason tokens.FinalizeReason
		if isDraining {
			reason = tokens.ReasonSoftCancel
		} else {
			reason = tokens.ReasonCompletion
		}

		result, err := se.tokenFinalizer.Finalize(ctx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          metadata.Model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: se.cancelTextSnapshot,
			Reason:         reason,
			ProviderTokens: &tokens.ProviderTokens{
				InputTokens:  metadata.InputTokens,
				OutputTokens: metadata.OutputTokens,
			},
		})
		if err == nil {
			metadata.InputTokens = result.InputTokens
			metadata.OutputTokens = result.OutputTokens
			if !result.IsFinal {
				se.logger.Debug("using finalized tokens",
					"turn_id", se.turnID,
					"input_tokens", result.InputTokens,
					"output_tokens", result.OutputTokens,
					"source", result.Source,
				)
			}
		}
	}

	// Always save token metadata (even for cancelled streams)
	// This ensures accurate billing even when user cancels mid-stream
	if err := se.updateTurnMetadata(ctx, metadata); err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to update turn metadata: %w", err))
		return err
	}

	// Persist OpenRouter generation record (if applicable)
	// This captures provider name, native tokens, and cost for each LLM request
	if err := se.persistOpenRouterGenerationRecord(ctx, metadata); err != nil {
		// Log error but don't fail the request - generation metadata is supplemental
		se.logger.Warn("failed to persist OpenRouter generation record",
			"error", err,
			"turn_id", se.turnID,
			"generation_id", se.getGenerationID(),
		)
	}

	// If in DrainMetadata state (soft cancel), skip tool continuation - just cleanup
	// Turn status is already "cancelled" (set by InterruptTurn)
	// Token metadata was saved above by updateTurnMetadata()
	// Client was already notified + disconnected by handleSoftCancel(); no completion SSE event needed
	if isDraining {
		// Transition to Completed state
		se.transitionTo(StateCompleted)

		se.logger.Info("stream completed after soft cancel, tokens saved",
			"turn_id", se.turnID,
			"input_tokens", metadata.InputTokens,
			"output_tokens", metadata.OutputTokens,
		)

		// Call cleanup callback if registered
		if se.onCleanup != nil {
			se.onCleanup()
		}

		return nil
	}

	// Check if we have collected tools to execute
	if len(se.collectedTools) > 0 && se.toolRegistry != nil {
		// Check hard limit to prevent infinite loops
		// (soft limit will be handled in executeToolsAndContinue via user message)
		hardLimit := se.maxToolRounds * 2
		if se.toolIteration >= hardLimit {
			se.logger.Warn("hard limit reached, creating error tool_results and allowing final response",
				"tool_iteration", se.toolIteration,
				"hard_limit", hardLimit,
				"collected_tools", len(se.collectedTools),
			)

			// Create error tool_result blocks for each pending tool_use
			// This ensures every tool_use has a corresponding tool_result (required by Claude API)
			errMsg := fmt.Sprintf("Tool execution limit reached (%d rounds). Please provide your final answer based on the information gathered so far.", hardLimit)
			if err := se.persistErrorToolResults(ctx, send, errMsg); err != nil {
				se.handleError(ctx, send, fmt.Errorf("failed to persist error tool results at hard limit: %w", err))
				return err
			}

			// Allow LLM to process one more response to wrap up gracefully
			// The error tool_results are now persisted, so executeToolsAndContinueWithLimit
			// will load them and let the LLM respond to them
			return se.executeToolsAndContinueWithLimit(ctx, send)
		}

		// Execute tools and continue streaming
		// Soft limit notification will be injected if needed in executeToolsAndContinue
		se.logger.Info("executing collected tools",
			"tool_count", len(se.collectedTools),
			"iteration", se.toolIteration,
		)
		return se.executeToolsAndContinue(ctx, send)
	}

	// No tools to execute (or stop_reason != "tool_use"), complete the turn
	return se.completeTurn(ctx, send, metadata.StopReason, metadata)
}

// canPersistPartialBlock returns true for block types that are useful when partial.
// Text and thinking are human-readable; tool_use JSON is unparseable when incomplete.
func canPersistPartialBlock(blockType string) bool {
	return blockType == llmModels.BlockTypeText || blockType == llmModels.BlockTypeThinking
}

// persistPartialBlocks saves any accumulated text/thinking blocks as partial blocks.
// Called during error/interruption handling to preserve partial LLM responses.
func (se *StreamExecutor) persistPartialBlocks(ctx context.Context) {
	if len(se.textAccumulator) == 0 {
		return
	}

	se.logger.Debug("persisting partial blocks",
		"turn_id", se.turnID,
		"block_count", len(se.textAccumulator),
	)

	for providerBlockIndex, textContent := range se.textAccumulator {
		if textContent == "" {
			continue
		}

		// Only persist text/thinking blocks - tool_use JSON is unparseable when partial
		blockType := llmModels.BlockTypeText // default to text
		if bt, exists := se.blockTypes[providerBlockIndex]; exists {
			blockType = bt
		}

		// Skip blocks that aren't useful when partial (e.g., tool_use with incomplete JSON)
		if !canPersistPartialBlock(blockType) {
			se.logger.Debug("skipping partial block (not text/thinking)",
				"block_type", blockType,
				"provider_index", providerBlockIndex,
			)
			continue
		}

		// Calculate turn-level sequence
		// maxBlockSequence tracks the highest completed block sequence
		// Partial blocks continue from there
		turnSequence := se.maxBlockSequence + 1 + providerBlockIndex

		// Create partial block
		partialBlock := &llmModels.TurnBlock{
			TurnID:      se.turnID,
			BlockType:   blockType,
			Sequence:    turnSequence,
			TextContent: &textContent,
			Status:      "partial",
		}

		// Persist the partial block
		if err := se.turnRepo.UpsertPartialBlock(ctx, partialBlock); err != nil {
			se.logger.Error("failed to persist partial text block",
				"error", err,
				"sequence", turnSequence,
				"text_length", len(textContent),
			)
		} else {
			se.logger.Debug("persisted partial text block",
				"sequence", turnSequence,
				"text_length", len(textContent),
			)
		}
	}

	// Clear accumulators after persistence attempt
	se.textAccumulator = nil
	se.blockTypes = nil
}

// handleError handles streaming errors
func (se *StreamExecutor) handleError(_ context.Context, send func(mstream.Event), err error) {
	// Use deadline to prevent blocking if DB is slow/unresponsive during cleanup
	// Background context because original context may already be cancelled
	persistCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
	defer cancel()

	// Check if we were in a cancel state
	currentState := se.getState()
	wasCancelled := currentState == StateDrainMetadata || currentState == StateHardCancelled

	// Use TokenFinalizer to count tokens for any interruption (cancel, error, timeout)
	// Do this BEFORE persisting partial blocks to capture all accumulated text
	if se.tokenFinalizer != nil {
		accumulatedText := se.getAccumulatedText()
		// Use cancel-time snapshot if accumulator was cleared by handleSoftCancel
		if accumulatedText == "" && se.cancelTextSnapshot != "" {
			accumulatedText = se.cancelTextSnapshot
		}

		var reason tokens.FinalizeReason
		if wasCancelled {
			reason = tokens.ReasonHardCancel
		} else {
			reason = tokens.ReasonError
		}

		result, finalizeErr := se.tokenFinalizer.Finalize(persistCtx, tokens.FinalizeRequest{
			TurnID:         se.turnID,
			Model:          se.model,
			GenerationID:   se.getGenerationID(),
			CancelSnapshot: accumulatedText,
			Reason:         reason,
			ProviderTokens: nil, // No provider tokens on error
		})
		if finalizeErr != nil {
			se.logger.Warn("failed to finalize tokens for interrupted stream",
				"error", finalizeErr,
			)
		} else if updateErr := se.persistTokenMetadata(persistCtx, result, ""); updateErr != nil {
			se.logger.Warn("failed to save finalized tokens",
				"error", updateErr,
			)
		} else if result != nil && (result.InputTokens > 0 || result.OutputTokens > 0) {
			se.logger.Debug("finalized tokens for interrupted stream",
				"input_tokens", result.InputTokens,
				"output_tokens", result.OutputTokens,
				"source", result.Source,
				"error", err.Error(),
			)
		}
	}

	// Persist any accumulated partial text blocks BEFORE marking turn as error
	se.persistPartialBlocks(persistCtx)

	// For OpenRouter: Enqueue /generation query for authoritative tokens (even on cancel)
	// This is critical because token counting may not be available immediately
	// Only do this for cancellations (hard-cancel or soft-cancel drain metadata)
	isCancelState := currentState == StateHardCancelled || currentState == StateDrainMetadata
	if isCancelState {
		generationID := se.getGenerationID()
		if generationID != "" && se.jobQueue != nil {
			querier, ok := se.provider.(domainllm.GenerationStatsQuerier)
			if ok {
				// Determine phase based on request index
				phase := "initial"
				if se.requestIndex > 0 {
					phase = "tool_continue"
				}

				// Create and enqueue enrichment job (isCancelled: true for longer retry window)
				job := jobs.NewEnrichGenerationJob(
					se.turnID,
					generationID,
					se.requestIndex,
					phase,
					se.model,
					se.turnRepo,
					querier,
					se.logger,
					true, // isCancelled: true (use longer retry window)
				)

				if err := se.jobQueue.Enqueue(job); err != nil {
					se.logger.Error("failed to enqueue generation enrichment job after cancel",
						"turn_id", se.turnID,
						"generation_id", generationID,
						"error", err,
					)
				} else {
					se.logger.Debug("enqueued generation enrichment job after cancel",
						"turn_id", se.turnID,
						"generation_id", generationID,
					)
				}
			}
		}
	}

	// Detect if this is a user cancellation (don't show error toast for these)
	// Check both: state-based (wasCancelled) and error-based (context.Canceled)
	// Bug fix: Previously only error-based check was used for SSE event, causing
	// hard cancel ("hard cancelled by user" error) to be misclassified as non-cancel
	// IMPORTANT: context.DeadlineExceeded is a TIMEOUT ERROR, not user cancellation
	// Only context.Canceled indicates user-initiated cancellation
	isContextCancelled := errors.Is(err, context.Canceled)
	isCancelled := wasCancelled || isContextCancelled

	// Update turn status in database
	// IMPORTANT: Skip UpdateTurnError if cancelled (soft/hard cancel case)
	// InterruptTurn already set status to "cancelled" - don't override it with "error"
	if isCancelled {
		se.logger.Debug("skipping UpdateTurnError for cancelled stream (status already cancelled)",
			"turn_id", se.turnID,
			"was_cancelled_state", wasCancelled,
			"context_cancelled", isContextCancelled,
		)
	} else {
		// Only update turn status to "error" for actual errors (not user cancellations)
		if updateErr := se.turnRepo.UpdateTurnError(persistCtx, se.turnID, err.Error()); updateErr != nil {
			se.logger.Error("failed to update turn error", "error", updateErr)
		}
	}

	// Send turn_error event
	errorMsg := err.Error()
	if errorMsg == "" {
		errorMsg = "Unknown error occurred"
	}

	se.sendEvent(send, llmModels.SSEEventTurnError, llmModels.TurnErrorEvent{
		TurnID:         se.turnID,
		Error:          errorMsg,
		IsCancelled:    isCancelled, // Now correctly true for both state-based and error-based cancels
		LastBlockIndex: nil,         // Could be determined from DB if needed
	})

	// Call cleanup callback if registered
	if se.onCleanup != nil {
		se.onCleanup()
	}
}

// getAccumulatedText returns all accumulated text from the text accumulator.
// Used for token counting on interruption.
func (se *StreamExecutor) getAccumulatedText() string {
	if len(se.textAccumulator) == 0 {
		return ""
	}

	// Deterministic ordering: map iteration is randomized.
	// Token counting should use content in provider block order.
	blockIndexes := make([]int, 0, len(se.textAccumulator))
	for idx := range se.textAccumulator {
		blockIndexes = append(blockIndexes, idx)
	}
	sort.Ints(blockIndexes)

	// Use strings.Builder for O(n) concatenation instead of O(n²) with +=
	var builder strings.Builder
	for _, idx := range blockIndexes {
		builder.WriteString(se.textAccumulator[idx])
	}
	return builder.String()
}

func (se *StreamExecutor) setGenerationID(id string) {
	se.generationMu.Lock()
	se.generationID = id
	se.generationMu.Unlock()
}

func (se *StreamExecutor) getGenerationID() string {
	se.generationMu.RLock()
	defer se.generationMu.RUnlock()
	return se.generationID
}

// sendEvent sends an event via mstream.
// Event IDs are automatically generated by the library when DEBUG mode is enabled.
func (se *StreamExecutor) sendEvent(send func(mstream.Event), eventType string, data interface{}) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		se.logger.Error("failed to marshal event data", "error", err, "event_type", eventType)
		return
	}

	// Create event with type - library will add event ID if DEBUG mode enabled
	event := mstream.NewEvent(jsonData).WithType(eventType)
	send(event)
}

// updateTurnMetadata updates the turn with final metadata
// Accumulates tokens (adds to existing) and overwrites other metadata atomically
func (se *StreamExecutor) updateTurnMetadata(ctx context.Context, metadata *domainllm.StreamMetadata) error {
	return se.turnRepo.AccumulateTokensAndUpdateMetadata(ctx, se.turnID,
		&llmRepo.TurnTokenUpdate{
			InputTokens:  metadata.InputTokens,
			OutputTokens: metadata.OutputTokens,
		},
		&llmRepo.TurnCompletionUpdate{
			Model:            &metadata.Model,
			StopReason:       &metadata.StopReason,
			ResponseMetadata: metadata.ResponseMetadata,
		},
	)
}

// persistTokenMetadata is a helper to persist token counts from TokenFinalizer.
// It centralizes the response_metadata structure and reason handling across timeout/error paths.
// Accumulates tokens (adds to existing) atomically with metadata update.
// For normal completion, use updateTurnMetadata() which handles full StreamMetadata.
func (se *StreamExecutor) persistTokenMetadata(ctx context.Context, result *tokens.TokenResult, reason string) error {
	if result == nil || (result.InputTokens == 0 && result.OutputTokens == 0) {
		return nil // Skip if no tokens to persist
	}

	// Build response_metadata with consistent fields
	responseMeta := map[string]interface{}{
		"token_metadata_final": result.IsFinal,
		"token_source":         result.Source,
	}
	// Only include reason if non-empty (avoids empty "reason":"" in JSON)
	if reason != "" {
		responseMeta["reason"] = reason
	}

	// Atomically accumulate tokens and update metadata
	// Note: StopReason is nil (keep existing) since this is partial/error recovery
	// Model is updated to ensure it's captured even on early termination
	model := se.model
	return se.turnRepo.AccumulateTokensAndUpdateMetadata(ctx, se.turnID,
		&llmRepo.TurnTokenUpdate{
			InputTokens:  result.InputTokens,
			OutputTokens: result.OutputTokens,
		},
		&llmRepo.TurnCompletionUpdate{
			Model:            &model,
			StopReason:       nil, // Keep existing stop_reason (intentional)
			ResponseMetadata: responseMeta,
		},
	)
}

// persistOpenRouterGenerationRecord persists an OpenRouter generation record to response_metadata.
// This captures provider name, native tokens, and cost for each LLM request (initial + tool continuations).
// Generation records are stored in response_metadata.openrouter.generations[] array.
func (se *StreamExecutor) persistOpenRouterGenerationRecord(ctx context.Context, metadata *domainllm.StreamMetadata) error {
	// Check if we have a generation ID
	generationID := se.getGenerationID()
	if generationID == "" {
		return nil // Not OpenRouter or no generation ID captured
	}

	// Determine phase based on tool iteration (0 = initial, 1+ = tool_continue)
	phase := "initial"
	if se.toolIteration > 0 {
		phase = "tool_continue"
	}

	// Try to query generation stats if provider supports it (capability interface)
	// This follows DIP - we depend on interface, not concrete type
	statsQuerier, ok := se.provider.(domainllm.GenerationStatsQuerier)
	if !ok {
		// Provider doesn't support stats API - finalize with available metadata
		// This ensures records are always finalized, even without enrichment
		basicRecord := &llmModels.GenerationRecord{
			ID:           generationID,
			RequestIndex: se.requestIndex,
			Phase:        phase,
			Model:        metadata.Model,
			Finalized:    true, // Finalized without enrichment
		}

		if err := se.turnRepo.AppendGenerationRecord(ctx, se.turnID, basicRecord); err != nil {
			return fmt.Errorf("failed to append basic generation record: %w", err)
		}

		se.logger.Debug("persisted basic generation record (no stats API)",
			"turn_id", se.turnID,
			"generation_id", generationID,
			"request_index", se.requestIndex,
			"phase", phase,
			"model", metadata.Model,
		)
		return nil
	}

	// Provider supports stats API - query with timeout
	// Use tight timeout to avoid blocking tool continuations
	apiCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	stats, err := statsQuerier.QueryGenerationStats(apiCtx, generationID)
	if err != nil {
		// Check if this is a 404 "not found" error (OpenRouter eventual consistency)
		if strings.Contains(err.Error(), "HTTP 404") || strings.Contains(err.Error(), "not found") {
			se.logger.Debug("generation stats not yet available, enqueuing background job",
				"turn_id", se.turnID,
				"generation_id", generationID,
				"request_index", se.requestIndex,
				"phase", phase,
				"model", metadata.Model,
				"error", err,
			)

			// Enqueue background job for retry with exponential backoff
			if se.jobQueue != nil { // nil check for backward compatibility
				job := jobs.NewEnrichGenerationJob(
					se.turnID,
					generationID,
					se.requestIndex,
					phase,
					metadata.Model,
					se.turnRepo,
					statsQuerier,
					se.logger,
					false, // isCancelled: false for normal completion
				)
				if err := se.jobQueue.Enqueue(job); err != nil {
					se.logger.Error("failed to enqueue generation enrichment job",
						"error", err,
						"turn_id", se.turnID,
						"generation_id", generationID,
					)
				}
			}

			// Note: Partial record already exists from processGenerationIDDiscovered()
			// Job will upgrade it to finalized=true when successful
			return nil
		}

		// Other errors (auth, network, etc.) - finalize immediately with error
		basicRecord := &llmModels.GenerationRecord{
			ID:                generationID,
			RequestIndex:      se.requestIndex,
			Phase:             phase,
			Model:             metadata.Model,
			Finalized:         true,
			FinalizeAttempts:  1,
			FinalizeLastError: err.Error(),
		}

		if err := se.turnRepo.AppendGenerationRecord(ctx, se.turnID, basicRecord); err != nil {
			return fmt.Errorf("failed to append basic generation record: %w", err)
		}

		se.logger.Warn("non-retryable error querying generation stats",
			"error", err,
			"turn_id", se.turnID,
			"generation_id", generationID,
			"request_index", se.requestIndex,
			"phase", phase,
			"model", metadata.Model,
		)
		return nil
	}

	// Success - enrich and finalize with complete API data
	enrichedRecord := &llmModels.GenerationRecord{
		ID:                     stats.ID,
		RequestIndex:           se.requestIndex,
		Phase:                  phase,
		Model:                  stats.Model,
		ProviderName:           stats.ProviderName,
		NativeTokensPrompt:     stats.NativeTokensPrompt,
		NativeTokensCompletion: stats.NativeTokensCompletion,
		NativeTokensReasoning:  stats.NativeTokensReasoning,
		NativeTokensCached:     stats.NativeTokensCached,
		TotalCost:              stats.TotalCost,
		FinishReason:           stats.FinishReason,
		CreatedAt:              stats.CreatedAt,
		UpstreamID:             stats.UpstreamID,
		Latency:                stats.Latency,
		Cancelled:              stats.Cancelled,
		Finalized:              true,                   // Successfully enriched with API data
		AdditionalFields:       stats.AdditionalFields, // Forward compatibility: preserve unknown fields
	}

	// Persist to database (atomic JSONB upsert-by-id)
	if err := se.turnRepo.AppendGenerationRecord(ctx, se.turnID, enrichedRecord); err != nil {
		return fmt.Errorf("failed to append enriched generation record: %w", err)
	}

	se.logger.Debug("persisted enriched OpenRouter generation record",
		"turn_id", se.turnID,
		"generation_id", stats.ID,
		"request_index", se.requestIndex,
		"phase", phase,
		"provider_name", stats.ProviderName,
		"native_tokens_prompt", stats.NativeTokensPrompt,
		"native_tokens_completion", stats.NativeTokensCompletion,
		"native_tokens_reasoning", stats.NativeTokensReasoning,
		"native_tokens_cached", stats.NativeTokensCached,
		"total_cost", stats.TotalCost,
		"latency_ms", stats.Latency,
	)

	return nil
}

// collectToolUse extracts tool use information from a tool_use block and adds it to the collection.
func (se *StreamExecutor) collectToolUse(block *llmModels.TurnBlock) {
	// Extract tool use info from block.Content
	// Expected format: {"tool_use_id": "...", "tool_name": "...", "input": {...}}
	if block.Content == nil {
		se.logger.Warn("tool_use block has no content",
			"sequence", block.Sequence,
			"block_type", block.BlockType)
		return
	}

	// Helper to get map keys for debugging
	getKeys := func(m map[string]interface{}) []string {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		return keys
	}

	// Extract tool_use_id (string)
	toolUseID, ok := block.Content["tool_use_id"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_use_id"]; exists {
			toolUseID = fmt.Sprintf("%v", val)
		} else {
			se.logger.Warn("tool_use block missing tool_use_id",
				"sequence", block.Sequence,
				"available_keys", getKeys(block.Content))
			return
		}
	}

	// Extract tool_name (string)
	toolName, ok := block.Content["tool_name"].(string)
	if !ok {
		// Try fallback: fmt.Sprintf
		if val, exists := block.Content["tool_name"]; exists {
			toolName = fmt.Sprintf("%v", val)
		} else {
			se.logger.Warn("tool_use block missing tool_name",
				"sequence", block.Sequence,
				"available_keys", getKeys(block.Content))
			return
		}
	}

	// Extract input (map[string]interface{})
	var toolInput map[string]interface{}
	inputRaw, exists := block.Content["input"]
	if !exists {
		se.logger.Warn("tool_use block missing input field",
			"sequence", block.Sequence,
			"available_keys", getKeys(block.Content))
		return
	}

	// Try direct type assertion first (fast path)
	toolInput, ok = inputRaw.(map[string]interface{})
	if !ok {
		// Fallback: marshal to JSON and unmarshal to target type
		// This handles cases where the type is correct but wrapped in interface{}
		inputJSON, err := json.Marshal(inputRaw)
		if err != nil {
			se.logger.Warn("tool_use block input cannot be marshaled",
				"sequence", block.Sequence,
				"input_type", fmt.Sprintf("%T", inputRaw),
				"error", err)
			return
		}

		if err := json.Unmarshal(inputJSON, &toolInput); err != nil {
			se.logger.Warn("tool_use block input cannot be unmarshaled",
				"sequence", block.Sequence,
				"input_json", string(inputJSON),
				"error", err)
			return
		}
	}

	// Add to collected tools
	toolCall := tools.ToolCall{
		ID:    toolUseID,
		Name:  toolName,
		Input: toolInput,
	}

	se.collectedTools = append(se.collectedTools, toolCall)

	// Track tool_use_id to block sequence mapping (for tool_executing events)
	se.toolUseIDToSequence[toolUseID] = block.Sequence
}

// executeToolsAndContinue executes the collected tools in parallel, persists the results,
// and continues streaming with the tool results.
func (se *StreamExecutor) executeToolsAndContinue(ctx context.Context, send func(mstream.Event)) error {
	// Filter out tools that already have results (from provider decode errors)
	// This prevents duplicate tool_result blocks for the same tool_use_id
	var toolsToExecute []tools.ToolCall
	for _, tc := range se.collectedTools {
		if !se.toolResultIDs[tc.ID] {
			toolsToExecute = append(toolsToExecute, tc)
		} else {
			se.logger.Debug("skipping tool execution - result already exists",
				"tool_use_id", tc.ID,
				"tool_name", tc.Name,
			)
		}
	}

	// NEW: Send tool_executing events before execution
	// This allows frontend to show "Running..." state during execution
	for _, tc := range toolsToExecute {
		blockSequence := -1 // Default if not found
		if seq, ok := se.toolUseIDToSequence[tc.ID]; ok {
			blockSequence = seq
		}
		se.sendEvent(send, llmModels.SSEEventToolExecuting, llmModels.ToolExecutingEvent{
			BlockIndex: blockSequence,
			ToolUseID:  tc.ID,
			ToolName:   tc.Name,
		})
	}

	// Execute filtered tools in parallel
	toolResults := se.toolRegistry.ExecuteParallel(ctx, toolsToExecute)

	se.logger.Info("tool execution completed",
		"tool_count", len(toolResults),
		"skipped_count", len(se.collectedTools)-len(toolsToExecute),
		"iteration", se.toolIteration,
	)

	// Persist tool_result blocks to database
	// Each tool result becomes a separate tool_result block
	// Start sequencing after the last block persisted during streaming
	nextSequence := se.maxBlockSequence + 1

	for i, toolResult := range toolResults {
		block := &llmModels.TurnBlock{
			TurnID:    se.turnID,
			BlockType: llmModels.BlockTypeToolResult,
			Sequence:  nextSequence + i,
			Content: map[string]interface{}{
				"tool_use_id": toolResult.ID,
				"tool_name":   toolResult.Name,
				"is_error":    toolResult.IsError,
			},
		}

		// Add result or error to content
		if toolResult.IsError {
			block.Content["error"] = toolResult.Error.Error()
		} else {
			block.Content["result"] = toolResult.Result
		}

		if err := se.persistAndStreamToolResult(ctx, send, block); err != nil {
			// Update turn status to error before returning
			if updateErr := se.turnRepo.UpdateTurnError(ctx, se.turnID, err.Error()); updateErr != nil {
				se.logger.Error("failed to update turn error status", "error", updateErr)
			}
			return err
		}
	}

	// 4. Check iteration limit with tiered approach
	se.toolIteration++
	se.requestIndex++ // Increment request index for next LLM request (for generation metadata tracking)

	softLimit := se.maxToolRounds
	hardLimit := se.maxToolRounds * 2

	// HARD LIMIT: Force graceful completion (safety backstop against infinite loops)
	if se.toolIteration >= hardLimit {
		se.logger.Warn("hard limit reached, forcing graceful completion",
			"iterations", se.toolIteration,
			"soft_limit", softLimit,
			"hard_limit", hardLimit,
		)
		return se.executeToolsAndContinueWithLimit(ctx, send)
	}

	// 5. Load conversation history with tool results (using TurnNavigator + TurnReader)
	path, err := se.turnNavigator.GetTurnPath(ctx, se.turnID)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to load turn path for continuation: %w", err))
		return fmt.Errorf("failed to load turn path for continuation: %w", err)
	}

	// Load blocks for all turns in the path
	for i := range path {
		blocks, err := se.turnReader.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			se.handleError(ctx, send, fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err))
			return fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err)
		}
		path[i].Blocks = blocks
	}

	// 6. Build messages using MessageBuilder (pure conversion)
	messages, err := se.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to build continuation messages: %w", err))
		return fmt.Errorf("failed to build continuation messages: %w", err)
	}

	// 6a. SOFT LIMIT: Inject user notification message if above soft limit
	// This gives the LLM a gentle reminder to wrap up, but still allows tool use if critical
	if se.toolIteration >= softLimit {
		notificationText := fmt.Sprintf(
			"You've exceeded the recommended tool usage limit of %d rounds. "+
				"Please consider providing your final answer based on the information you've gathered.",
			softLimit,
		)

		notificationMsg := domainllm.Message{
			Role: "user",
			Content: []*llmModels.TurnBlock{
				{
					BlockType:   llmModels.BlockTypeText,
					TextContent: &notificationText,
				},
			},
		}

		// Prepend notification so LLM sees it first
		messages = append([]domainllm.Message{notificationMsg}, messages...)

		se.logger.Info("soft limit reached, injected user notification",
			"iterations", se.toolIteration,
			"soft_limit", softLimit,
			"hard_limit", hardLimit,
		)
	}

	// 7. Create continuation request (reuse original params)
	contReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    se.req.Model,
		Params:   se.req.Params, // Reuse original params (temperature, max_tokens, system prompt, etc.)
	}

	// DEBUG: Log continuation request details to diagnose 400 errors
	se.logContinuationRequest(contReq)

	// 8. Call provider for continuation stream
	// NOTE: Use ctx from workFunc (NOT context.Background())
	// - The background goroutine already uses context.Background() (see service.go:304)
	// - This ctx comes from mstream, which manages stream lifecycle
	// - Browser disconnection doesn't cancel this ctx (goroutine-level protection)
	// - Using mstream's ctx prevents goroutine leaks and respects cancellation
	contStreamChan, err := se.provider.StreamResponse(ctx, contReq)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("continuation stream failed: %w", err))
		return fmt.Errorf("continuation stream failed: %w", err)
	}

	se.logger.Info("continuation stream started",
		"iteration", se.toolIteration,
		"next_expected_block", se.maxBlockSequence+1,
	)

	// 9. Reset tool collection for next iteration
	se.collectedTools = nil
	se.toolResultIDs = make(map[string]bool)
	se.toolUseIDToSequence = make(map[string]int) // Reset tool_use_id -> sequence mapping
	se.currentToolMeta = make(map[int]toolMeta)   // Reset tool metadata per block

	// 10. Process continuation stream (recursive call)
	// maxBlockSequence will be updated by processProviderStream -> processCompleteBlock
	return se.processProviderStream(ctx, contStreamChan, send)
}

// persistAndStreamToolResult persists a tool_result block and streams it via SSE.
// This is the shared helper used by both executeToolsAndContinue (real results)
// and persistErrorToolResults (error results) to avoid code duplication.
func (se *StreamExecutor) persistAndStreamToolResult(ctx context.Context, send func(mstream.Event), block *llmModels.TurnBlock) error {
	// 1. Persist to database
	if err := se.turnRepo.CreateTurnBlock(ctx, block); err != nil {
		se.logger.Error("failed to persist tool result block",
			"error", err,
			"tool_use_id", block.Content["tool_use_id"],
		)
		return fmt.Errorf("failed to persist tool result: %w", err)
	}

	// 2. Update sequence tracking
	if block.Sequence > se.maxBlockSequence {
		se.maxBlockSequence = block.Sequence
	}

	// 3. Stream SSE events
	blockType := block.BlockType
	se.sendEvent(send, llmModels.SSEEventBlockStart, llmModels.BlockStartEvent{
		BlockIndex: block.Sequence,
		BlockType:  &blockType,
	})

	if contentJSON, err := json.Marshal(block.Content); err == nil {
		contentStr := string(contentJSON)
		se.sendEvent(send, llmModels.SSEEventBlockDelta, llmModels.BlockDeltaEvent{
			BlockIndex: block.Sequence,
			DeltaType:  llmModels.DeltaTypeJSON,
			JSONDelta:  &contentStr,
		})
	} else {
		se.logger.Error("failed to marshal tool result content",
			"error", err,
			"tool_use_id", block.Content["tool_use_id"],
		)
	}

	se.sendEvent(send, llmModels.SSEEventBlockStop, llmModels.BlockStopEvent{
		BlockIndex: block.Sequence,
	})

	se.logger.Debug("persisted and streamed tool result",
		"tool_use_id", block.Content["tool_use_id"],
		"is_error", block.Content["is_error"],
		"sequence", block.Sequence,
	)

	return nil
}

// persistErrorToolResults creates error tool_result blocks for all collected tools
// without executing them. Used when we hit hard limit before tool execution.
// This ensures every tool_use has a corresponding tool_result (required by Claude API).
func (se *StreamExecutor) persistErrorToolResults(ctx context.Context, send func(mstream.Event), errMsg string) error {
	if len(se.collectedTools) == 0 {
		return nil
	}

	se.logger.Info("persisting error tool results for collected tools",
		"tool_count", len(se.collectedTools),
		"error_message", errMsg,
	)

	nextSequence := se.maxBlockSequence + 1

	for i, tool := range se.collectedTools {
		block := &llmModels.TurnBlock{
			TurnID:    se.turnID,
			BlockType: llmModels.BlockTypeToolResult,
			Sequence:  nextSequence + i,
			Content: map[string]interface{}{
				"tool_use_id": tool.ID,
				"tool_name":   tool.Name,
				"is_error":    true,
				"error":       errMsg,
			},
		}

		if err := se.persistAndStreamToolResult(ctx, send, block); err != nil {
			return err
		}
	}

	// Clear collected tools after persisting error results
	se.collectedTools = nil
	se.toolResultIDs = make(map[string]bool)
	se.toolUseIDToSequence = make(map[string]int) // Reset tool_use_id -> sequence mapping
	se.currentToolMeta = make(map[int]toolMeta)   // Reset tool metadata per block

	return nil
}

// executeToolsAndContinueWithLimit is called when tool round limit is reached.
// It loads conversation history (including tool results just persisted), injects
// a limit note into the last tool_result, and streams one final LLM response.
// This allows graceful completion where the LLM synthesizes findings instead of abrupt cutoff.
func (se *StreamExecutor) executeToolsAndContinueWithLimit(ctx context.Context, send func(mstream.Event)) error {
	se.requestIndex++ // Increment request index for graceful completion LLM request (for generation metadata tracking)

	se.logger.Info("graceful completion: injecting limit note for final LLM response",
		"iteration", se.toolIteration,
		"max_rounds", se.maxToolRounds,
	)

	// 1. Load conversation history with tool results (using TurnNavigator + TurnReader)
	path, err := se.turnNavigator.GetTurnPath(ctx, se.turnID)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to load turn path for graceful completion: %w", err))
		return fmt.Errorf("failed to load turn path for graceful completion: %w", err)
	}

	// Load blocks for all turns in the path
	for i := range path {
		blocks, err := se.turnReader.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			se.handleError(ctx, send, fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err))
			return fmt.Errorf("failed to load blocks for turn %s: %w", path[i].ID, err)
		}
		path[i].Blocks = blocks
	}

	// 2. Build messages using MessageBuilder (pure conversion)
	messages, err := se.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("failed to build messages for graceful completion: %w", err))
		return fmt.Errorf("failed to build messages for graceful completion: %w", err)
	}

	// 3. INJECT LIMIT NOTE into last tool_result message
	// This tells the LLM it has reached the limit and should respond with gathered info
	// Note: This modifies messages in-memory only (NOT persisted to database)
	injectToolLimitNote(messages, se.toolIteration, se.maxToolRounds)

	// 4. Create continuation request with system prompt override
	// IMPORTANT: Keep tools array even though we don't want the LLM to call them.
	// Reason: Messages contain role:"tool" blocks (for OpenRouter), and OpenRouter
	// rejects role:"tool" messages when no tools are defined in the request (400 error).
	// The system prompt override is sufficient to prevent the LLM from calling tools.
	paramsWithoutTools := *se.req.Params // Shallow copy
	// paramsWithoutTools.Tools remains unchanged (keeps original tools for message validation)

	// Dual-layer defense against unwanted tool calls:
	// Layer 1: System prompt override (strong instruction to NOT call tools)
	// Layer 2: Tool result limit note (provides context - already injected above)
	limitInstruction := "\n\nIMPORTANT: You have reached your tool usage limit. " +
		"Do NOT format any tool calls. " +
		"Provide your answer in natural language based on the information you gathered. " +
		"Let the user know you reached the tool limit and are providing your best answer with available information."

	if paramsWithoutTools.System != nil {
		originalPrompt := *paramsWithoutTools.System
		updatedPrompt := originalPrompt + limitInstruction
		paramsWithoutTools.System = &updatedPrompt
	} else {
		paramsWithoutTools.System = &limitInstruction
	}

	contReq := &domainllm.GenerateRequest{
		Messages: messages, // Contains limit note in last tool_result (Layer 2)
		Model:    se.req.Model,
		Params:   &paramsWithoutTools, // Tools kept + limit instruction (Layer 1)
	}

	// DEBUG: Log continuation request details to diagnose 400 errors
	se.logContinuationRequest(contReq)

	// 5. Call provider for final continuation stream
	contStreamChan, err := se.provider.StreamResponse(ctx, contReq)
	if err != nil {
		se.handleError(ctx, send, fmt.Errorf("graceful completion stream failed: %w", err))
		return fmt.Errorf("graceful completion stream failed: %w", err)
	}

	se.logger.Info("graceful completion stream started",
		"iteration", se.toolIteration,
		"next_expected_block", se.maxBlockSequence+1,
	)

	// 6. Reset tool collection (no more tool rounds allowed)
	se.collectedTools = nil
	se.toolResultIDs = make(map[string]bool)
	se.toolUseIDToSequence = make(map[string]int) // Reset tool_use_id -> sequence mapping
	se.currentToolMeta = make(map[int]toolMeta)   // Reset tool metadata per block

	// 7. Process final stream (will complete with end_turn stop_reason)
	return se.processProviderStream(ctx, contStreamChan, send)
}

// injectToolLimitNote appends a limit notification to the last tool_result block.
// This tells the LLM it has reached the maximum tool rounds and should respond
// with the information gathered so far. The note is injected into messages
// before sending to the provider, but is NOT persisted to the database.
func injectToolLimitNote(messages []domainllm.Message, currentRound, maxRounds int) {
	// Find last message with role="user" (tool results are sent as user messages)
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" {
			// Find last tool_result block in this message
			blocks := messages[i].Content
			for j := len(blocks) - 1; j >= 0; j-- {
				if blocks[j].BlockType == llmModels.BlockTypeToolResult {
					// Inject limit note into the result field
					// Content is already map[string]interface{} - no type assertion needed
					content := blocks[j].Content
					if result, exists := content["result"]; exists {
						// Append limit note to existing result
						resultStr := fmt.Sprintf("%v", result)
						limitNote := fmt.Sprintf(
							"\n\n---\nNote: You have reached the maximum tool rounds (%d/%d). Please provide your response based on the information you've gathered so far. No additional tool calls are available.",
							currentRound, maxRounds,
						)
						content["result"] = resultStr + limitNote
					}
					return
				}
			}
		}
	}
}

// completeTurn marks the turn as complete and sends turn_complete event.
// This is called ONLY when stop_reason != "tool_use" (or max iterations hit).
// The turn remains "streaming" during all continuation rounds.
// metadata can be nil (e.g., when max_tool_rounds is hit before next stream)
func (se *StreamExecutor) completeTurn(
	ctx context.Context,
	send func(mstream.Event),
	stopReason string,
	metadata *domainllm.StreamMetadata,
) error {
	se.logger.Info("completing turn",
		"turn_id", se.turnID,
		"stop_reason", stopReason,
		"total_tool_iterations", se.toolIteration,
	)

	// Update turn status in database
	// NOTE: This marks the FINAL completion after all continuation rounds
	if err := se.turnRepo.UpdateTurnStatus(ctx, se.turnID, "complete", nil); err != nil {
		se.logger.Error("failed to update turn status", "error", err)
		// Continue despite error - SSE event is more important
	}

	// Build completion event
	completeEvent := llmModels.TurnCompleteEvent{
		TurnID:     se.turnID,
		StopReason: stopReason,
	}

	// Add metadata if available (may be nil for max_tool_rounds)
	if metadata != nil {
		completeEvent.InputTokens = metadata.InputTokens
		completeEvent.OutputTokens = metadata.OutputTokens
		completeEvent.ResponseMetadata = metadata.ResponseMetadata
	}

	// Send turn_complete SSE event
	se.sendEvent(send, llmModels.SSEEventTurnComplete, completeEvent)

	// Call cleanup callback if registered
	if se.onCleanup != nil {
		se.onCleanup()
	}

	return nil
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
