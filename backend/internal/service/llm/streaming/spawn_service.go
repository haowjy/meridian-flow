package streaming

// spawn_service.go — SpawnService for foreground agent spawning.
//
// Creates child threads that inherit their parent's work item, streams with the
// resolved persona, and blocks until the child completes (foreground mode).
//
// Circular dependency resolution:
//   - SpawnService depends on SpawnInvoker (narrow interface implemented by StreamingService)
//     for creating child turns and streaming. It does NOT depend on StreamingService directly.
//   - StreamingService depends on SpawnInvoker for the spawn_agent tool to call CreateSpawn.
//   - The actual wiring happens at construction time via SetSpawnService on StreamingService.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	domainerrors "meridian/internal/domain/errors"
	domainllm "meridian/internal/domain/llm"
)

// SpawnService manages the lifecycle of spawned child agent threads.
// It validates spawn limits, creates child threads, delegates streaming to
// the ChildThreadBootstrapper, and blocks until completion (foreground mode).
type SpawnService struct {
	threadRepo       domainllm.ThreadStore
	txManager        domain.TransactionManager
	config           *config.Config
	bootstrapper     *ChildThreadBootstrapper
	executorRegistry *ExecutorRegistry // for executor-level cancellation; may be nil
	activeChildren   sync.Map          // childThreadID -> struct{}: tracks currently-running spawns
	logger           *slog.Logger
}

// NewSpawnService creates a new SpawnService.
// The bootstrapper handles child thread creation and streaming delegation.
// executorRegistry is optional (nil disables executor-level cancellation in CancelSpawn).
func NewSpawnService(
	threadRepo domainllm.ThreadStore,
	txManager domain.TransactionManager,
	cfg *config.Config,
	bootstrapper *ChildThreadBootstrapper,
	executorRegistry *ExecutorRegistry,
	logger *slog.Logger,
) *SpawnService {
	return &SpawnService{
		threadRepo:       threadRepo,
		txManager:        txManager,
		config:           cfg,
		bootstrapper:     bootstrapper,
		executorRegistry: executorRegistry,
		logger:           logger,
	}
}

// CreateSpawn creates a child thread, starts streaming, and blocks until the
// child completes or the spawn timeout fires.
//
// Steps:
//  1. Validate spawn limits (depth, concurrent count) inside a transaction
//  2. Create child thread with parent_thread_id, spawn_depth, and spawn_status=running
//  3. Delegate to ChildThreadBootstrapper to create initial turn and start streaming
//  4. Block on completion channel with spawn_timeout context
//  5. Extract SpawnResult from the child thread's final state
func (s *SpawnService) CreateSpawn(ctx context.Context, req *domainllm.SpawnRequest) (*domainllm.SpawnResult, error) {
	if req == nil {
		return nil, domain.NewValidationError("spawn request is nil")
	}
	if req.ParentThreadID == "" {
		return nil, domain.NewValidationError("parent_thread_id is required")
	}
	if req.AgentSlug == "" {
		return nil, domain.NewValidationError("agent_slug is required")
	}
	if req.Prompt == "" {
		return nil, domain.NewValidationError("prompt is required")
	}

	// Load parent thread to get spawn_depth and validate it exists.
	parentThread, err := s.threadRepo.GetThread(ctx, req.ParentThreadID, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to load parent thread: %w", err)
	}

	// Create child thread with spawn fields set.
	childDepth := parentThread.SpawnDepth + 1
	spawnStatus := domainllm.SpawnStatusRunning
	now := time.Now().UTC()

	childThread := &domainllm.Thread{
		ProjectID:      req.ProjectID,
		UserID:         req.UserID,
		Title:          fmt.Sprintf("[spawn] %s", truncate(req.Prompt, 80)),
		Persona:        &req.AgentSlug,
		ParentThreadID: &req.ParentThreadID,
		SpawnStatus:    &spawnStatus,
		SpawnDepth:     childDepth,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	// Inherit work_item_id from parent.
	if parentThread.WorkItemID != nil {
		childThread.WorkItemID = parentThread.WorkItemID
	}

	// Validate limits and create the child row in one transaction so the
	// concurrent-spawn count check and insert are race-free.
	if err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		if err := s.validateSpawnLimits(txCtx, parentThread, req); err != nil {
			return err
		}
		return s.threadRepo.CreateThread(txCtx, childThread)
	}); err != nil {
		return nil, fmt.Errorf("failed to create child thread: %w", err)
	}

	s.logger.Info("child thread created for spawn",
		"child_thread_id", childThread.ID,
		"parent_thread_id", req.ParentThreadID,
		"agent_slug", req.AgentSlug,
		"spawn_depth", childDepth,
	)

	// Track this child as actively running. Removed in all terminal paths below.
	s.activeChildren.Store(childThread.ID, struct{}{})

	// Enforce spawn timeout via context.WithTimeout.
	timeoutDuration := time.Duration(s.config.LLM.SpawnTimeoutSeconds) * time.Second
	if timeoutDuration <= 0 {
		timeoutDuration = 5 * time.Minute // safety fallback
	}
	spawnCtx, cancel := context.WithTimeout(ctx, timeoutDuration)
	defer cancel()

	// Delegate to bootstrapper: create initial turn and start streaming.
	// The bootstrapper returns a completion channel that fires when the child finishes.
	completionCh, err := s.bootstrapper.BootstrapAndStream(spawnCtx, childThread, req)
	if err != nil {
		// Mark child as failed since streaming never started.
		s.markSpawnFailed(childThread.ID, fmt.Sprintf("bootstrap failed: %v", err))
		return nil, fmt.Errorf("failed to bootstrap child thread: %w", err)
	}

	// Block on completion or timeout.
	select {
	case result := <-completionCh:
		// Child finished. Persist final status.
		if result.Status == "" {
			result.Status = "succeeded"
		}
		s.activeChildren.Delete(childThread.ID)
		s.persistSpawnResult(childThread.ID, result)
		return result, nil

	case <-spawnCtx.Done():
		// Timeout or parent cancellation.
		timedOutStatus := domainllm.SpawnStatusTimedOut
		if ctx.Err() != nil {
			// Parent context cancelled (not timeout) — mark as cancelled.
			timedOutStatus = domainllm.SpawnStatusCancelled
		}
		s.activeChildren.Delete(childThread.ID)
		s.markSpawnStatus(childThread.ID, timedOutStatus)
		return &domainllm.SpawnResult{
			ChildThreadID: childThread.ID,
			Status:        string(timedOutStatus),
			Summary:       fmt.Sprintf("spawn %s after %v", timedOutStatus, timeoutDuration),
		}, nil
	}
}

// GetSpawnStatus retrieves the current status of a child thread spawn.
func (s *SpawnService) GetSpawnStatus(ctx context.Context, parentThreadID, childThreadID string) (*domainllm.SpawnResult, error) {
	children, err := s.threadRepo.ListChildThreads(ctx, parentThreadID)
	if err != nil {
		return nil, fmt.Errorf("failed to list child threads: %w", err)
	}

	for _, child := range children {
		if child.ID == childThreadID {
			result := &domainllm.SpawnResult{
				ChildThreadID: child.ID,
			}
			if child.SpawnStatus != nil {
				result.Status = string(*child.SpawnStatus)
			}
			if child.SpawnResultJSON != nil {
				// Overlay the stored result onto our response.
				var stored domainllm.SpawnResult
				if err := json.Unmarshal(*child.SpawnResultJSON, &stored); err == nil {
					result.Summary = stored.Summary
					result.Artifacts = stored.Artifacts
					result.Metadata = stored.Metadata
				}
			}
			return result, nil
		}
	}

	return nil, domain.NewNotFoundError("spawn", fmt.Sprintf("child thread %s not found under parent %s", childThreadID, parentThreadID))
}

// CancelSpawn cancels an active child thread spawn.
// If an executor is running for the child thread (tracked via executorRegistry),
// it is hard-cancelled immediately. The DB spawn_status is then updated to cancelled.
func (s *SpawnService) CancelSpawn(ctx context.Context, parentThreadID, childThreadID string) error {
	children, err := s.threadRepo.ListChildThreads(ctx, parentThreadID)
	if err != nil {
		return fmt.Errorf("failed to list child threads: %w", err)
	}

	for _, child := range children {
		if child.ID == childThreadID {
			if child.SpawnStatus != nil && *child.SpawnStatus == domainllm.SpawnStatusRunning {
				// Cancel the streaming executor if one is active.
				// executorRegistry.GetByThread scans by threadID, which matches child thread.
				if s.executorRegistry != nil {
					if executor := s.executorRegistry.GetByThread(childThreadID); executor != nil {
						s.logger.Debug("CancelSpawn: cancelling active executor",
							"child_thread_id", childThreadID,
							"parent_thread_id", parentThreadID,
						)
						executor.RequestHardCancel()
					}
				}
				return s.threadRepo.UpdateSpawnStatus(ctx, childThreadID, domainllm.SpawnStatusCancelled, nil)
			}
			// Already terminal — no-op.
			return nil
		}
	}

	return domain.NewNotFoundError("spawn", fmt.Sprintf("child thread %s not found under parent %s", childThreadID, parentThreadID))
}

// validateSpawnLimits checks depth and concurrent spawn limits.
func (s *SpawnService) validateSpawnLimits(ctx context.Context, parent *domainllm.Thread, req *domainllm.SpawnRequest) error {
	maxDepth := s.config.LLM.MaxSpawnDepth
	if maxDepth <= 0 {
		maxDepth = 3
	}

	// Depth check: O(1) because spawn_depth is denormalized on the parent row.
	if parent.SpawnDepth+1 > maxDepth {
		return domainerrors.SpawnDepthExceeded(maxDepth)
	}

	// Concurrent spawn limit per work item.
	if req.WorkItemID != "" {
		maxConcurrent := s.config.LLM.MaxConcurrentSpawns
		if maxConcurrent <= 0 {
			maxConcurrent = 5
		}

		running, err := s.threadRepo.CountRunningSpawnsByWorkItem(ctx, req.WorkItemID)
		if err != nil {
			return fmt.Errorf("failed to count running spawns: %w", err)
		}

		if running >= maxConcurrent {
			return domainerrors.SpawnLimitExceeded()
		}
	}

	return nil
}

// markSpawnFailed marks a child thread as failed with an error summary.
func (s *SpawnService) markSpawnFailed(childThreadID string, summary string) {
	s.activeChildren.Delete(childThreadID) // bootstrap failed; no longer active
	result := &domainllm.SpawnResult{
		ChildThreadID: childThreadID,
		Status:        string(domainllm.SpawnStatusFailed),
		Summary:       summary,
	}
	s.persistSpawnResult(childThreadID, result)
}

// markSpawnStatus updates just the spawn status (no result).
func (s *SpawnService) markSpawnStatus(childThreadID string, status domainllm.SpawnStatus) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := s.threadRepo.UpdateSpawnStatus(ctx, childThreadID, status, nil); err != nil {
		s.logger.Error("failed to update spawn status",
			"child_thread_id", childThreadID,
			"status", status,
			"error", err,
		)
	}
}

// persistSpawnResult marshals the result and persists it on the child thread.
func (s *SpawnService) persistSpawnResult(childThreadID string, result *domainllm.SpawnResult) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	status := domainllm.SpawnStatus(result.Status)

	resultJSON, err := json.Marshal(result)
	if err != nil {
		s.logger.Error("failed to marshal spawn result",
			"child_thread_id", childThreadID,
			"error", err,
		)
		return
	}

	raw := json.RawMessage(resultJSON)
	if err := s.threadRepo.UpdateSpawnStatus(ctx, childThreadID, status, &raw); err != nil {
		s.logger.Error("failed to persist spawn result",
			"child_thread_id", childThreadID,
			"error", err,
		)
	}
}

// truncate shortens a string to maxLen, appending "..." if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}

// ChildThreadBootstrapper handles the mechanics of creating a child thread's
// initial turn and starting streaming. This is extracted from the CreateTurn path
// so that both user-initiated turns and spawn-initiated turns share the same logic.
//
// The bootstrapper does NOT depend on SpawnService — it only depends on the
// streaming infrastructure (turn writer, providers, etc.). This avoids the circular
// dependency between SpawnService and StreamingService.
type ChildThreadBootstrapper struct {
	streamingSvc domainllm.StreamingService
	turnReader   domainllm.TurnReader
	logger       *slog.Logger
}

// NewChildThreadBootstrapper creates a new bootstrapper.
func NewChildThreadBootstrapper(
	streamingSvc domainllm.StreamingService,
	turnReader domainllm.TurnReader,
	logger *slog.Logger,
) *ChildThreadBootstrapper {
	return &ChildThreadBootstrapper{
		streamingSvc: streamingSvc,
		turnReader:   turnReader,
		logger:       logger,
	}
}

// BootstrapAndStream creates an initial user turn on the child thread and starts
// streaming the assistant response. Returns a channel that receives the SpawnResult
// when the child thread's streaming completes.
//
// The child thread must already exist in the database (created by SpawnService).
func (b *ChildThreadBootstrapper) BootstrapAndStream(
	ctx context.Context,
	childThread *domainllm.Thread,
	req *domainllm.SpawnRequest,
) (<-chan *domainllm.SpawnResult, error) {
	// Create the initial user turn on the child thread via CreateTurn.
	// This reuses the full turn creation pipeline (persona resolution, tool registry, etc.).
	threadID := childThread.ID
	textContent := req.Prompt
	createReq := &domainllm.CreateTurnRequest{
		ThreadID:    &threadID,
		UserID:      req.UserID,
		Role:        "user",
		PersonaSlug: &req.AgentSlug,
		TurnBlocks: []domainllm.TurnBlockInput{
			{
				BlockType:   "text",
				TextContent: &textContent,
			},
		},
	}

	resp, err := b.streamingSvc.CreateTurn(ctx, createReq)
	if err != nil {
		return nil, fmt.Errorf("failed to create initial turn on child thread: %w", err)
	}

	b.logger.Info("child thread bootstrap started",
		"child_thread_id", childThread.ID,
		"assistant_turn_id", resp.AssistantTurn.ID,
		"persona", req.AgentSlug,
	)

	// Create a completion channel. A goroutine polls for turn completion.
	// In a future iteration this could be wired directly to the executor's completion
	// callback, but polling is simpler and correct for v1.
	completionCh := make(chan *domainllm.SpawnResult, 1)

	go b.waitForCompletion(ctx, childThread.ID, resp.AssistantTurn.ID, completionCh)

	return completionCh, nil
}

// waitForCompletion polls the assistant turn's status until it reaches a terminal state.
// Once terminal, it builds a SpawnResult and sends it on the completion channel.
func (b *ChildThreadBootstrapper) waitForCompletion(
	ctx context.Context,
	childThreadID string,
	assistantTurnID string,
	completionCh chan<- *domainllm.SpawnResult,
) {
	defer close(completionCh)

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			completionCh <- &domainllm.SpawnResult{
				ChildThreadID: childThreadID,
				Status:        string(domainllm.SpawnStatusTimedOut),
				Summary:       "spawn context cancelled while waiting for completion",
			}
			return

		case <-ticker.C:
			// Poll the persisted assistant turn status from the DB.
			// Terminal status is the source of truth for spawn completion.
			turn, err := b.turnReader.GetTurn(ctx, assistantTurnID)
			if err != nil {
				b.logger.Warn("waitForCompletion: failed to load assistant turn",
					"assistant_turn_id", assistantTurnID,
					"child_thread_id", childThreadID,
					"error", err,
				)
				continue
			}

			if isTerminalTurnStatus(turn.Status) {
				completionCh <- spawnResultForTerminalTurn(childThreadID, turn.Status)
				return
			}
		}
	}
}

func isTerminalTurnStatus(status domainllm.TurnStatus) bool {
	switch status {
	case domainllm.TurnStatusComplete, domainllm.TurnStatusCancelled, domainllm.TurnStatusError, domainllm.TurnStatusCreditLimited:
		return true
	default:
		return false
	}
}

func spawnResultForTerminalTurn(childThreadID string, status domainllm.TurnStatus) *domainllm.SpawnResult {
	switch status {
	case domainllm.TurnStatusComplete:
		return &domainllm.SpawnResult{
			ChildThreadID: childThreadID,
			Status:        string(domainllm.SpawnStatusSucceeded),
			Summary:       fmt.Sprintf("child thread %s completed", childThreadID),
		}
	case domainllm.TurnStatusCancelled:
		return &domainllm.SpawnResult{
			ChildThreadID: childThreadID,
			Status:        string(domainllm.SpawnStatusCancelled),
			Summary:       fmt.Sprintf("child thread %s cancelled", childThreadID),
		}
	default:
		return &domainllm.SpawnResult{
			ChildThreadID: childThreadID,
			Status:        string(domainllm.SpawnStatusFailed),
			Summary:       fmt.Sprintf("child thread %s ended with assistant turn status %s", childThreadID, status),
		}
	}
}
