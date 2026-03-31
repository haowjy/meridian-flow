package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/tokens"
)

// =============================================================================
// Mock Implementations
// =============================================================================

// mockTurnWriter tracks block persistence calls for testing
type mockTurnWriter struct {
	blocks       []*domainllm.TurnBlock
	mu           sync.Mutex
	persistDelay time.Duration // Artificial delay to widen race window
}

func newMockTurnWriter() *mockTurnWriter {
	return &mockTurnWriter{
		blocks: make([]*domainllm.TurnBlock, 0),
	}
}

func (m *mockTurnWriter) CreateTurn(ctx context.Context, turn *domainllm.Turn) error {
	return nil
}

func (m *mockTurnWriter) CreateTurnBlock(ctx context.Context, block *domainllm.TurnBlock) error {
	// Artificial delay to widen the race window (used by race condition tests)
	if m.persistDelay > 0 {
		time.Sleep(m.persistDelay)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.blocks = append(m.blocks, block)
	return nil
}

func (m *mockTurnWriter) CreateTurnBlocks(ctx context.Context, blocks []domainllm.TurnBlock) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range blocks {
		m.blocks = append(m.blocks, &blocks[i])
	}
	return nil
}

func (m *mockTurnWriter) UpdateTurnStatus(ctx context.Context, turnID string, status domainllm.TurnStatus, completedAt *domainllm.Turn) error {
	return nil
}

func (m *mockTurnWriter) UpdateTurn(ctx context.Context, turn *domainllm.Turn) error {
	return nil
}

func (m *mockTurnWriter) UpdateTurnMetadata(ctx context.Context, turnID string, metadata map[string]interface{}) error {
	return nil
}

func (m *mockTurnWriter) UpdateTurnError(ctx context.Context, turnID string, errorMsg string) error {
	return nil
}

func (m *mockTurnWriter) UpsertPartialBlock(ctx context.Context, block *domainllm.TurnBlock) error {
	return nil
}

func (m *mockTurnWriter) AccumulateTokensAndUpdateMetadata(ctx context.Context, turnID string, tokens *domainllm.TurnTokenUpdate, completion *domainllm.TurnCompletionUpdate) error {
	return nil
}

func (m *mockTurnWriter) AppendGenerationRecord(ctx context.Context, turnID string, record *domainllm.GenerationRecord) error {
	return nil
}

func (m *mockTurnWriter) GetPersistedBlocks() []*domainllm.TurnBlock {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]*domainllm.TurnBlock, len(m.blocks))
	copy(result, m.blocks)
	return result
}

var _ domainllm.TurnWriter = (*mockTurnWriter)(nil)

// mockTurnReader provides minimal TurnReader implementation
type mockTurnReader struct{}

func (m *mockTurnReader) GetTurn(ctx context.Context, turnID string) (*domainllm.Turn, error) {
	return &domainllm.Turn{ID: turnID}, nil
}

func (m *mockTurnReader) GetRootTurns(ctx context.Context, threadID string) ([]domainllm.Turn, error) {
	return nil, nil
}

func (m *mockTurnReader) GetTurnBlocks(ctx context.Context, turnID string) ([]domainllm.TurnBlock, error) {
	return nil, nil
}

func (m *mockTurnReader) GetTurnBlocksForTurns(ctx context.Context, turnIDs []string) (map[string][]domainllm.TurnBlock, error) {
	return nil, nil
}

func (m *mockTurnReader) GetLastBlockSequence(ctx context.Context, turnID string) (int, error) {
	return -1, nil
}

var _ domainllm.TurnReader = (*mockTurnReader)(nil)

// mockTurnNavigator provides minimal TurnNavigator implementation
type mockTurnNavigator struct{}

func (m *mockTurnNavigator) GetTurnPath(ctx context.Context, turnID string) ([]domainllm.Turn, error) {
	return nil, nil
}

func (m *mockTurnNavigator) GetTurnSiblings(ctx context.Context, turnID string) ([]domainllm.Turn, error) {
	return nil, nil
}

func (m *mockTurnNavigator) GetSiblingsForTurns(ctx context.Context, turnIDs []string) (map[string][]string, error) {
	return nil, nil
}

func (m *mockTurnNavigator) GetPaginatedTurns(ctx context.Context, threadID, userID string, fromTurnID *string, limit int, direction string, updateLastViewed bool) (*domainllm.PaginatedTurnsResponse, error) {
	return nil, nil
}

var _ domainllm.TurnNavigator = (*mockTurnNavigator)(nil)

// mockProvider simulates LLM streaming with controllable behavior
type mockProvider struct {
	cancelCount atomic.Int32
	ctx         context.Context
	cancelFunc  context.CancelFunc
	cancelled   chan struct{}
	blockToSend *domainllm.TurnBlock
	sendBlock   chan struct{} // Signal to send the block
	blockSent   chan struct{} // Signal that block was sent
	started     chan struct{} // Closed when StreamResponse begins (for test coordination)
	complete    chan struct{} // Close to trigger immediate metadata emission (replaces 5s timeout)
}

func newMockProvider() *mockProvider {
	ctx, cancel := context.WithCancel(context.Background())
	return &mockProvider{
		ctx:        ctx,
		cancelFunc: cancel,
		cancelled:  make(chan struct{}),
		sendBlock:  make(chan struct{}),
		blockSent:  make(chan struct{}),
		started:    make(chan struct{}),
		complete:   make(chan struct{}),
	}
}

func (m *mockProvider) GenerateResponse(ctx context.Context, req *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
	return nil, fmt.Errorf("not implemented")
}

func (m *mockProvider) StreamResponse(ctx context.Context, req *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	// Create a new channel for this stream
	out := make(chan domainllm.StreamEvent, 10)

	go func() {
		defer close(out)

		// Signal that streaming has started (for test coordination)
		select {
		case <-m.started:
			// Already closed
		default:
			close(m.started)
		}

		// Wait for signal to send block
		select {
		case <-m.sendBlock:
			// Send the block
			if m.blockToSend != nil {
				out <- domainllm.StreamEvent{Block: m.blockToSend}
				close(m.blockSent)
			}
		case <-ctx.Done():
			m.cancelCount.Add(1)
			select {
			case <-m.cancelled:
			default:
				close(m.cancelled)
			}
			return
		case <-m.ctx.Done():
			m.cancelCount.Add(1)
			select {
			case <-m.cancelled:
			default:
				close(m.cancelled)
			}
			return
		}

		// Wait for context cancellation or explicit completion signal
		select {
		case <-ctx.Done():
			m.cancelCount.Add(1)
			select {
			case <-m.cancelled:
			default:
				close(m.cancelled)
			}
			return
		case <-m.ctx.Done():
			m.cancelCount.Add(1)
			select {
			case <-m.cancelled:
			default:
				close(m.cancelled)
			}
			return
		case <-m.complete:
			// Test signals completion - send metadata immediately
			out <- domainllm.StreamEvent{
				Metadata: &domainllm.StreamMetadata{
					Model:        "test-model",
					StopReason:   "end_turn",
					InputTokens:  100,
					OutputTokens: 50,
				},
			}
		}
	}()

	return out, nil
}

func (m *mockProvider) Name() string {
	return "mock"
}

func (m *mockProvider) SupportsModel(model string) bool {
	return model == "test-model"
}

var _ domainllm.LLMProvider = (*mockProvider)(nil)

type mockCreditAdmissionChecker struct {
	err error
}

func (m *mockCreditAdmissionChecker) CheckAdmission(ctx context.Context, userID string) error {
	return m.err
}

func (m *mockCreditAdmissionChecker) HasPurchasedCredits(ctx context.Context, userID string) bool {
	return false
}

type mockCreditSettler struct{}

func (m *mockCreditSettler) SettleAuthoritativeRequest(ctx context.Context, req billing.SettleRequestInput) error {
	return nil
}

func (m *mockCreditSettler) RetryPendingSettlement(ctx context.Context, req billing.RetryPendingSettlementInput) error {
	return nil
}

func (m *mockCreditSettler) MarkPendingSettlement(ctx context.Context, req billing.MarkPendingSettlementInput) error {
	return nil
}

// mockMessageBuilder provides minimal MessageBuilder implementation
type mockMessageBuilder struct{}

func (m *mockMessageBuilder) BuildMessages(ctx context.Context, path []domainllm.Turn) ([]domainllm.Message, error) {
	return nil, nil
}

var _ domainllm.MessageBuilder = (*mockMessageBuilder)(nil)

// mockTokenFinalizer provides minimal TokenFinalizer implementation
type mockTokenFinalizer struct{}

func (m *mockTokenFinalizer) Finalize(ctx context.Context, req tokens.FinalizeRequest) (*tokens.TokenResult, error) {
	return &tokens.TokenResult{
		InputTokens:  100,
		OutputTokens: 50,
		IsFinal:      true,
		Source:       "mock",
	}, nil
}

var _ tokens.TokenFinalizer = (*mockTokenFinalizer)(nil)

// =============================================================================
// Bug Reproduction Tests (TDD - These should FAIL with current implementation)
// =============================================================================

// TestRaceCondition_CancelDuringPersistence directly tests the race condition
// between RequestSoftCancel and persistence checks.
//
// This test simulates the race without full mstream integration:
// 1. The streaming goroutine checks state == StateStreaming (passes)
// 2. Handler thread calls RequestSoftCancel (queues command)
// 3. Streaming goroutine checks state again (still Streaming - command not processed!)
// 4. Persistence proceeds despite cancel intent
//
// With PersistenceGuard fix:
// 1. RequestSoftCancel calls Disarm() atomically FIRST
// 2. IsArmed() check fails immediately
// 3. Persistence is blocked
func TestRaceCondition_CancelDuringPersistence(t *testing.T) {
	// This test directly demonstrates the race:
	// - State check uses mutex (only sees state after transitionTo)
	// - Cancel command just queues, doesn't change state immediately
	// - PersistenceGuard.Disarm() is atomic and immediately visible

	// Simulate the race scenario
	guard := NewPersistenceGuard()

	// Channels for synchronization
	checkStarted := make(chan struct{})
	cancelDone := make(chan struct{})
	done := make(chan struct{}) // Signals goroutine completion

	// Track results
	var persistedAfterDisarm bool
	_ = persistedAfterDisarm // Will be set in goroutine

	// Simulate the streaming goroutine's persistence check pattern
	go func() {
		defer close(done) // Signal completion when goroutine exits

		// First check (simulates checking at top of processCompleteBlock)
		if guard.IsArmed() {
			// Signal that we're in the "race window"
			close(checkStarted)

			// Wait for cancel to be called (simulates delay in callback)
			<-cancelDone

			// Second check (simulates check inside PersistAndClear callback)
			// With current bug: This would check getState() which hasn't changed yet
			// With fix: This checks IsArmed() which WAS changed
			if guard.IsArmed() {
				persistedAfterDisarm = true
			}
			// If not armed, persistence is correctly blocked
		}
	}()

	// Wait for streaming goroutine to reach the race window
	<-checkStarted

	// Simulate cancel handler calling Disarm (this is immediate)
	guard.Disarm()
	close(cancelDone)

	// Wait for goroutine to complete (no arbitrary sleep)
	<-done

	// With PersistenceGuard: persistedAfterDisarm should be FALSE
	// because IsArmed() immediately sees the Disarm() call
	if persistedAfterDisarm {
		t.Error("Bug: Persistence proceeded after Disarm() was called")
		t.Log("This indicates the atomic flag is not working correctly")
	} else {
		t.Log("PersistenceGuard correctly prevented persistence after Disarm()")
	}
}

// TestRaceCondition_StateCheckVsGuard demonstrates why state check alone is insufficient
// and why we need the atomic PersistenceGuard.
func TestRaceCondition_StateCheckVsGuard(t *testing.T) {
	// This simulates the current (buggy) implementation using state check
	// vs the fix using PersistenceGuard

	type stateCheck struct {
		mu    sync.RWMutex
		state string // "streaming", "draining", etc.
	}

	sc := &stateCheck{state: "streaming"}

	// Track if persistence would proceed (use atomics to avoid test race)
	var persistedWithStateCheck atomic.Bool
	var persistedWithGuard atomic.Bool

	// Channels
	checkStarted := make(chan struct{})
	commandQueued := make(chan struct{})
	done := make(chan struct{})

	// PersistenceGuard for comparison
	guard := NewPersistenceGuard()

	// Simulate streaming goroutine
	go func() {
		defer close(done)

		// Check state (simulates getState())
		sc.mu.RLock()
		stateIsStreaming := sc.state == "streaming"
		sc.mu.RUnlock()

		if stateIsStreaming {
			close(checkStarted)

			// Wait for cancel command to be "queued"
			// (In real code, this is the delay between checking and persisting)
			<-commandQueued

			// Check again - in real code, this would be inside PersistAndClear callback
			// BUG: State hasn't changed because we're still in the callback,
			// and the select loop hasn't processed the command yet
			sc.mu.RLock()
			stillStreaming := sc.state == "streaming"
			sc.mu.RUnlock()

			if stillStreaming {
				persistedWithStateCheck.Store(true)
			}

			// With PersistenceGuard, this would work correctly
			if guard.IsArmed() {
				persistedWithGuard.Store(true)
			}
		}
	}()

	// Wait for goroutine to be in race window
	<-checkStarted

	// Simulate cancel handler:
	// 1. With current code: Just queue command, don't change state
	//    (state only changes when select loop processes command)
	// 2. With fix: Call Disarm() first (immediate visibility)

	// Fix: Disarm immediately
	guard.Disarm()

	// Bug: State isn't changed because command is just queued
	// (In real code, transitionTo() only happens in select loop)

	close(commandQueued)
	<-done // Wait for goroutine to finish

	// With state check only: Persistence proceeds (BUG)
	if persistedWithStateCheck.Load() {
		t.Log("BUG CONFIRMED: State check allowed persistence after cancel was requested")
		t.Log("This happens because state only changes when select loop processes command")
	}

	// With PersistenceGuard: Persistence is blocked (CORRECT)
	if !persistedWithGuard.Load() {
		t.Log("FIX CONFIRMED: PersistenceGuard correctly blocked persistence")
	} else {
		t.Error("PersistenceGuard failed to block persistence")
	}
}

// TestStreamExecutor_SoftCancelDrainTimeoutStopsProvider verifies that if we soft-cancel
// and the provider never finishes, the drain timeout cancels the provider stream.
func TestStreamExecutor_SoftCancelDrainTimeoutStopsProvider(t *testing.T) {
	// Create mocks
	turnWriter := newMockTurnWriter()
	provider := newMockProvider()
	logger := slog.Default()

	// Use a very short timeout for testing
	shortTimeoutSeconds := 1 // 1 second timeout

	// Create executor with short timeout
	executor := NewStreamExecutor(StreamExecutorConfig{
		TurnID:                   "test-turn-456",
		ThreadID:                 "test-thread-456",
		UserID:                   "test-user-456",
		ProjectID:                "test-project-456",
		Model:                    "test-model",
		ProviderName:             "mock",
		TurnWriter:               turnWriter,
		TurnReader:               &mockTurnReader{},
		TurnNavigator:            &mockTurnNavigator{},
		Provider:                 provider,
		ToolRegistry:             nil,
		MessageBuilder:           &mockMessageBuilder{},
		Logger:                   logger,
		CreditAdmissionChecker:   &mockCreditAdmissionChecker{},
		CreditSettler:            &mockCreditSettler{},
		SettlementMode:           billing.CreditSettlementInlineAuthoritative,
		MaxToolRounds:            5,
		DebugMode:                false,
		TokenFinalizer:           &mockTokenFinalizer{},
		JobQueue:                 nil,
		SoftCancelTimeoutSeconds: shortTimeoutSeconds,
		InterjectionRouter:       nil,
		StreamRuntime:            nil,
	})

	// Start streaming
	executor.Start(&domainllm.GenerateRequest{
		Model: "test-model",
	})

	// Wait for streaming to start using channel coordination (no arbitrary sleep)
	select {
	case <-provider.started:
		// Provider started streaming
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for provider to start streaming")
	}

	// Request soft cancel - this starts the timeout timer
	executor.RequestSoftCancel()

	// Wait for provider to be cancelled by the drain timeout
	// The executor's drain timeout (1s) should cancel the provider
	select {
	case <-provider.cancelled:
		t.Log("provider was cancelled after soft-cancel drain timeout")
	case <-time.After(time.Duration(shortTimeoutSeconds)*time.Second + 500*time.Millisecond):
		cancelCount := provider.cancelCount.Load()
		t.Fatalf("provider was not cancelled after drain timeout. cancelCount=%d", cancelCount)
	}
}

// =============================================================================
// Behavior Tests (These should PASS with current and fixed implementation)
// =============================================================================

// TestStreamExecutor_IdempotentCancel verifies that multiple cancel calls are safe
func TestStreamExecutor_IdempotentCancel(t *testing.T) {
	turnWriter := newMockTurnWriter()
	provider := newMockProvider()
	logger := slog.Default()

	executor := NewStreamExecutor(StreamExecutorConfig{
		TurnID:                   "test-turn-789",
		ThreadID:                 "test-thread-789",
		UserID:                   "test-user-789",
		ProjectID:                "test-project-789",
		Model:                    "test-model",
		ProviderName:             "mock",
		TurnWriter:               turnWriter,
		TurnReader:               &mockTurnReader{},
		TurnNavigator:            &mockTurnNavigator{},
		Provider:                 provider,
		ToolRegistry:             nil,
		MessageBuilder:           &mockMessageBuilder{},
		Logger:                   logger,
		CreditAdmissionChecker:   &mockCreditAdmissionChecker{},
		CreditSettler:            &mockCreditSettler{},
		SettlementMode:           billing.CreditSettlementInlineAuthoritative,
		MaxToolRounds:            5,
		DebugMode:                false,
		TokenFinalizer:           &mockTokenFinalizer{},
		JobQueue:                 nil,
		SoftCancelTimeoutSeconds: 300,
		InterjectionRouter:       nil,
		StreamRuntime:            nil,
	})

	// Start streaming
	executor.Start(&domainllm.GenerateRequest{
		Model: "test-model",
	})

	// Wait for streaming to start using channel coordination (no arbitrary sleep)
	select {
	case <-provider.started:
		// Provider started streaming
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for provider to start streaming")
	}

	// Multiple cancel calls should be safe (idempotent)
	// This tests the buffered channel (size 1) behavior
	for range 10 {
		executor.RequestSoftCancel()
	}

	// Should not panic or block - test passes if it completes
	// No need for arbitrary sleep - the loop completes synchronously
}

// TestStreamExecutor_HardCancelIdempotent verifies hard cancel idempotency
func TestStreamExecutor_HardCancelIdempotent(t *testing.T) {
	turnWriter := newMockTurnWriter()
	provider := newMockProvider()
	logger := slog.Default()

	executor := NewStreamExecutor(StreamExecutorConfig{
		TurnID:                   "test-turn-abc",
		ThreadID:                 "test-thread-abc",
		UserID:                   "test-user-abc",
		ProjectID:                "test-project-abc",
		Model:                    "test-model",
		ProviderName:             "mock",
		TurnWriter:               turnWriter,
		TurnReader:               &mockTurnReader{},
		TurnNavigator:            &mockTurnNavigator{},
		Provider:                 provider,
		ToolRegistry:             nil,
		MessageBuilder:           &mockMessageBuilder{},
		Logger:                   logger,
		CreditAdmissionChecker:   &mockCreditAdmissionChecker{},
		CreditSettler:            &mockCreditSettler{},
		SettlementMode:           billing.CreditSettlementInlineAuthoritative,
		MaxToolRounds:            5,
		DebugMode:                false,
		TokenFinalizer:           &mockTokenFinalizer{},
		JobQueue:                 nil,
		SoftCancelTimeoutSeconds: 300,
		InterjectionRouter:       nil,
		StreamRuntime:            nil,
	})

	// Start streaming
	executor.Start(&domainllm.GenerateRequest{
		Model: "test-model",
	})

	// Wait for streaming to start using channel coordination (no arbitrary sleep)
	select {
	case <-provider.started:
		// Provider started streaming
	case <-time.After(1 * time.Second):
		t.Fatal("timeout waiting for provider to start streaming")
	}

	// Multiple hard cancel calls should be safe
	for range 10 {
		executor.RequestHardCancel()
	}

	// Should not panic or block - test passes if it completes
	// No need for arbitrary sleep - the loop completes synchronously
}

// TestStreamExecutor_PreStartTerminateDoesNotResurrectStreaming verifies the
// pre-start cancel race fix: Start() may still be called by the runtime goroutine,
// but workFunc must not transition back to Streaming or start provider IO.
func TestStreamExecutor_PreStartTerminateDoesNotResurrectStreaming(t *testing.T) {
	turnWriter := newMockTurnWriter()
	provider := newMockProvider()
	logger := slog.Default()

	executor := NewStreamExecutor(StreamExecutorConfig{
		TurnID:                   "test-turn-prestart-cancel",
		ThreadID:                 "test-thread-prestart-cancel",
		UserID:                   "test-user-prestart-cancel",
		ProjectID:                "test-project-prestart-cancel",
		Model:                    "test-model",
		ProviderName:             "mock",
		TurnWriter:               turnWriter,
		TurnReader:               &mockTurnReader{},
		TurnNavigator:            &mockTurnNavigator{},
		Provider:                 provider,
		ToolRegistry:             nil,
		MessageBuilder:           &mockMessageBuilder{},
		Logger:                   logger,
		CreditAdmissionChecker:   &mockCreditAdmissionChecker{},
		CreditSettler:            &mockCreditSettler{},
		SettlementMode:           billing.CreditSettlementInlineAuthoritative,
		MaxToolRounds:            5,
		DebugMode:                false,
		TokenFinalizer:           &mockTokenFinalizer{},
		JobQueue:                 nil,
		SoftCancelTimeoutSeconds: 300,
		InterjectionRouter:       nil,
		StreamRuntime:            nil,
	})

	executor.Terminate(ReasonHardCancelled, TerminateOpts{})

	if got := executor.getState(); got != StateHardCancelled {
		t.Fatalf("executor state before Start = %v, want %v", got, StateHardCancelled)
	}

	// Simulate startStreamingExecution calling Start() after pre-start cancel.
	executor.Start(&domainllm.GenerateRequest{Model: "test-model"})

	select {
	case <-provider.started:
		t.Fatal("provider stream started after pre-start terminate")
	case <-time.After(200 * time.Millisecond):
		// expected: no provider start
	}

	if got := executor.getState(); got != StateHardCancelled {
		t.Fatalf("executor state after Start = %v, want %v", got, StateHardCancelled)
	}
}
