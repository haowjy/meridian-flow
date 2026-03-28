package streaming

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"

	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/tokens"
)

type terminateStatusCall struct {
	turnID string
	status domainllm.TurnStatus
}

type terminateTokenUpdateCall struct {
	turnID     string
	tokens     domainllm.TurnTokenUpdate
	completion domainllm.TurnCompletionUpdate
}

type terminateTestStore struct {
	mu sync.Mutex

	turn *domainllm.Turn

	statusCalls      []terminateStatusCall
	errorCalls       []string
	updateCalls      []*domainllm.Turn
	tokenUpdateCalls []terminateTokenUpdateCall
	partialBlocks    []*domainllm.TurnBlock
}

func newTerminateTestStore(initialStatus domainllm.TurnStatus) *terminateTestStore {
	return &terminateTestStore{
		turn: &domainllm.Turn{
			ID:     "test-turn",
			Status: initialStatus,
		},
	}
}

func (s *terminateTestStore) CreateTurn(context.Context, *domainllm.Turn) error {
	return nil
}

func (s *terminateTestStore) CreateTurnBlock(context.Context, *domainllm.TurnBlock) error {
	return nil
}

func (s *terminateTestStore) CreateTurnBlocks(context.Context, []domainllm.TurnBlock) error {
	return nil
}

func (s *terminateTestStore) UpdateTurnStatus(_ context.Context, turnID string, status domainllm.TurnStatus, completedAt *domainllm.Turn) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.statusCalls = append(s.statusCalls, terminateStatusCall{turnID: turnID, status: status})
	s.turn.ID = turnID
	s.turn.Status = status
	if completedAt != nil {
		s.turn.CompletedAt = completedAt.CompletedAt
		if completedAt.Error != nil {
			errMsg := *completedAt.Error
			s.turn.Error = &errMsg
		}
	}
	return nil
}

func (s *terminateTestStore) UpdateTurn(_ context.Context, turn *domainllm.Turn) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cloned := cloneTurn(turn)
	s.updateCalls = append(s.updateCalls, cloned)
	s.turn = cloned
	return nil
}

func (s *terminateTestStore) UpdateTurnMetadata(context.Context, string, map[string]interface{}) error {
	return nil
}

func (s *terminateTestStore) UpdateTurnError(_ context.Context, turnID string, errorMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.errorCalls = append(s.errorCalls, errorMsg)
	s.turn.ID = turnID
	s.turn.Status = domainllm.TurnStatusError
	s.turn.Error = ptrString(errorMsg)
	return nil
}

func (s *terminateTestStore) UpsertPartialBlock(_ context.Context, block *domainllm.TurnBlock) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	cloned := *block
	s.partialBlocks = append(s.partialBlocks, &cloned)
	return nil
}

func (s *terminateTestStore) AccumulateTokensAndUpdateMetadata(_ context.Context, turnID string, tokenUpdate *domainllm.TurnTokenUpdate, completion *domainllm.TurnCompletionUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	call := terminateTokenUpdateCall{turnID: turnID}
	if tokenUpdate != nil {
		call.tokens = *tokenUpdate
	}
	if completion != nil {
		call.completion = cloneCompletionUpdate(completion)
	}
	s.tokenUpdateCalls = append(s.tokenUpdateCalls, call)
	return nil
}

func (s *terminateTestStore) AppendGenerationRecord(context.Context, string, *domainllm.GenerationRecord) error {
	return nil
}

func (s *terminateTestStore) GetTurn(_ context.Context, turnID string) (*domainllm.Turn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cloned := cloneTurn(s.turn)
	cloned.ID = turnID
	return cloned, nil
}

func (s *terminateTestStore) GetRootTurns(context.Context, string) ([]domainllm.Turn, error) {
	return nil, nil
}

func (s *terminateTestStore) GetTurnBlocks(context.Context, string) ([]domainllm.TurnBlock, error) {
	return nil, nil
}

func (s *terminateTestStore) GetTurnBlocksForTurns(context.Context, []string) (map[string][]domainllm.TurnBlock, error) {
	return nil, nil
}

func (s *terminateTestStore) GetLastBlockSequence(context.Context, string) (int, error) {
	return -1, nil
}

func (s *terminateTestStore) snapshotTurn() *domainllm.Turn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneTurn(s.turn)
}

var _ domainllm.TurnWriter = (*terminateTestStore)(nil)
var _ domainllm.TurnReader = (*terminateTestStore)(nil)

type recordingTokenFinalizer struct {
	mu     sync.Mutex
	calls  []tokens.FinalizeRequest
	result tokens.TokenResult
	err    error
}

func newRecordingTokenFinalizer() *recordingTokenFinalizer {
	return &recordingTokenFinalizer{
		result: tokens.TokenResult{
			InputTokens:  11,
			OutputTokens: 7,
			IsFinal:      true,
			Source:       "terminate-test",
		},
	}
}

func (f *recordingTokenFinalizer) Finalize(_ context.Context, req tokens.FinalizeRequest) (*tokens.TokenResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls = append(f.calls, req)
	if f.err != nil {
		return nil, f.err
	}
	result := f.result
	return &result, nil
}

func (f *recordingTokenFinalizer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

var _ tokens.TokenFinalizer = (*recordingTokenFinalizer)(nil)

type recordingCreditSettler struct {
	mu           sync.Mutex
	settleCalls  []billing.SettleRequestInput
	pendingCalls []billing.MarkPendingSettlementInput
}

func (s *recordingCreditSettler) SettleAuthoritativeRequest(_ context.Context, req billing.SettleRequestInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.settleCalls = append(s.settleCalls, req)
	return nil
}

func (s *recordingCreditSettler) RetryPendingSettlement(context.Context, billing.RetryPendingSettlementInput) error {
	return nil
}

func (s *recordingCreditSettler) MarkPendingSettlement(_ context.Context, req billing.MarkPendingSettlementInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.pendingCalls = append(s.pendingCalls, req)
	return nil
}

func (s *recordingCreditSettler) settleCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.settleCalls)
}

var _ billing.CreditSettler = (*recordingCreditSettler)(nil)

func TestTerminate_AllReasons(t *testing.T) {
	t.Parallel()

	type want struct {
		terminalState     ExecutorState
		finalTurnStatus   domainllm.TurnStatus
		finalTurnError    *string
		statusCalls       int
		errorCalls        int
		updateCalls       int
		finalizeCalls     int
		settleCalls       int
		persistPartials   bool
		finalizeTokens    bool
		settleBilling     bool
		initialTurnStatus domainllm.TurnStatus
	}

	cases := []struct {
		name   string
		reason TerminateReason
		opts   TerminateOpts
		want   want
	}{
		{
			name:   "completed",
			reason: ReasonCompleted,
			opts:   TerminateOpts{Metadata: terminateTestMetadata(), StopReason: "end_turn"},
			want: want{
				terminalState:     StateCompleted,
				finalTurnStatus:   domainllm.TurnStatusComplete,
				statusCalls:       1,
				finalizeCalls:     1,
				settleCalls:       1,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusStreaming,
			},
		},
		{
			name:   "soft_cancel_drained",
			reason: ReasonSoftCancelDrained,
			opts:   TerminateOpts{Metadata: terminateTestMetadata()},
			want: want{
				terminalState:     StateCompleted,
				finalTurnStatus:   domainllm.TurnStatusCancelled,
				finalizeCalls:     1,
				settleCalls:       1,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusCancelled,
			},
		},
		{
			name:   "hard_cancelled",
			reason: ReasonHardCancelled,
			opts:   TerminateOpts{Metadata: terminateTestMetadata(), ErrorMessage: "cancelled"},
			want: want{
				terminalState:     StateHardCancelled,
				finalTurnStatus:   domainllm.TurnStatusCancelled,
				finalizeCalls:     1,
				settleCalls:       1,
				persistPartials:   true,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusCancelled,
			},
		},
		{
			name:   "soft_cancel_timeout",
			reason: ReasonSoftCancelTimeout,
			opts:   TerminateOpts{Metadata: terminateTestMetadata(), ErrorMessage: "timeout waiting for provider metadata"},
			want: want{
				terminalState:     StateTimedOut,
				finalTurnStatus:   domainllm.TurnStatusCancelled,
				finalizeCalls:     1,
				settleCalls:       1,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusCancelled,
			},
		},
		{
			name:   "error",
			reason: ReasonError,
			opts:   TerminateOpts{Metadata: terminateTestMetadata(), ErrorMessage: "provider request failed"},
			want: want{
				terminalState:     StateErrored,
				finalTurnStatus:   domainllm.TurnStatusError,
				finalTurnError:    ptrString("provider request failed"),
				errorCalls:        1,
				finalizeCalls:     1,
				settleCalls:       1,
				persistPartials:   true,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusStreaming,
			},
		},
		{
			name:   "credits_exhausted",
			reason: ReasonCreditsExhausted,
			opts:   TerminateOpts{},
			want: want{
				terminalState:     StateCompleted,
				finalTurnStatus:   domainllm.TurnStatusCreditLimited,
				finalTurnError:    ptrString(creditLimitedErrorMessage),
				updateCalls:       1,
				persistPartials:   true,
				initialTurnStatus: domainllm.TurnStatusStreaming,
			},
		},
		{
			name:   "stream_switch",
			reason: ReasonStreamSwitch,
			opts:   TerminateOpts{Metadata: terminateTestMetadata()},
			want: want{
				terminalState:     StateCompleted,
				finalTurnStatus:   domainllm.TurnStatusComplete,
				statusCalls:       1,
				finalizeCalls:     1,
				settleCalls:       1,
				finalizeTokens:    true,
				settleBilling:     true,
				initialTurnStatus: domainllm.TurnStatusStreaming,
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, tc.want.initialTurnStatus)
			setExecutorState(executor, StateStreaming)

			if got := tc.reason.ShouldPersistPartials(); got != tc.want.persistPartials {
				t.Fatalf("ShouldPersistPartials() = %v, want %v", got, tc.want.persistPartials)
			}
			if got := tc.reason.ShouldFinalizeTokens(); got != tc.want.finalizeTokens {
				t.Fatalf("ShouldFinalizeTokens() = %v, want %v", got, tc.want.finalizeTokens)
			}
			if got := tc.reason.ShouldSettleBilling(); got != tc.want.settleBilling {
				t.Fatalf("ShouldSettleBilling() = %v, want %v", got, tc.want.settleBilling)
			}

			executor.Terminate(tc.reason, tc.opts)

			if got := executor.getState(); got != tc.want.terminalState {
				t.Fatalf("executor state = %v, want %v", got, tc.want.terminalState)
			}
			if cleanupCalls.count != 1 {
				t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
			}
			if got := len(store.statusCalls); got != tc.want.statusCalls {
				t.Fatalf("UpdateTurnStatus calls = %d, want %d", got, tc.want.statusCalls)
			}
			if got := len(store.errorCalls); got != tc.want.errorCalls {
				t.Fatalf("UpdateTurnError calls = %d, want %d", got, tc.want.errorCalls)
			}
			if got := len(store.updateCalls); got != tc.want.updateCalls {
				t.Fatalf("UpdateTurn calls = %d, want %d", got, tc.want.updateCalls)
			}
			if got := finalizer.callCount(); got != tc.want.finalizeCalls {
				t.Fatalf("token finalizer calls = %d, want %d", got, tc.want.finalizeCalls)
			}
			if got := settler.settleCallCount(); got != tc.want.settleCalls {
				t.Fatalf("credit settler calls = %d, want %d", got, tc.want.settleCalls)
			}

			turn := store.snapshotTurn()
			if turn.Status != tc.want.finalTurnStatus {
				t.Fatalf("turn status = %q, want %q", turn.Status, tc.want.finalTurnStatus)
			}
			assertTurnError(t, turn.Error, tc.want.finalTurnError)
		})
	}
}

func TestTerminate_Idempotent(t *testing.T) {
	t.Parallel()

	executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, domainllm.TurnStatusStreaming)
	setExecutorState(executor, StateStreaming)

	opts := TerminateOpts{Metadata: terminateTestMetadata(), StopReason: "end_turn"}

	executor.Terminate(ReasonCompleted, opts)
	executor.Terminate(ReasonCompleted, opts)

	if got := executor.getState(); got != StateCompleted {
		t.Fatalf("executor state = %v, want %v", got, StateCompleted)
	}
	if cleanupCalls.count != 1 {
		t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
	}
	if got := len(store.statusCalls); got != 1 {
		t.Fatalf("UpdateTurnStatus calls = %d, want 1", got)
	}
	if got := finalizer.callCount(); got != 1 {
		t.Fatalf("token finalizer calls = %d, want 1", got)
	}
	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("credit settler calls = %d, want 1", got)
	}
}

func TestTerminate_PreStartWindow(t *testing.T) {
	t.Parallel()

	executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, domainllm.TurnStatusStreaming)

	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("Terminate panicked before Start: %v", recovered)
			}
		}()
		executor.Terminate(ReasonError, TerminateOpts{
			Metadata:     terminateTestMetadata(),
			ErrorMessage: "pre-start failure",
		})
	}()

	if got := executor.getState(); got != StateErrored {
		t.Fatalf("executor state = %v, want %v", got, StateErrored)
	}
	if cleanupCalls.count != 1 {
		t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
	}
	if got := len(store.errorCalls); got != 1 {
		t.Fatalf("UpdateTurnError calls = %d, want 1", got)
	}
	if got := finalizer.callCount(); got != 1 {
		t.Fatalf("token finalizer calls = %d, want 1", got)
	}
	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("credit settler calls = %d, want 1", got)
	}
}

func TestTerminate_DifferentReasonAfterTerminal(t *testing.T) {
	t.Parallel()

	executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, domainllm.TurnStatusStreaming)
	setExecutorState(executor, StateStreaming)

	executor.Terminate(ReasonCompleted, TerminateOpts{
		Metadata:   terminateTestMetadata(),
		StopReason: "end_turn",
	})
	executor.Terminate(ReasonError, TerminateOpts{
		Metadata:     terminateTestMetadata(),
		ErrorMessage: "should be ignored",
	})

	if got := executor.getState(); got != StateCompleted {
		t.Fatalf("executor state = %v, want %v", got, StateCompleted)
	}
	if cleanupCalls.count != 1 {
		t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
	}
	if got := len(store.statusCalls); got != 1 {
		t.Fatalf("UpdateTurnStatus calls = %d, want 1", got)
	}
	if got := len(store.errorCalls); got != 0 {
		t.Fatalf("UpdateTurnError calls = %d, want 0", got)
	}
	if got := finalizer.callCount(); got != 1 {
		t.Fatalf("token finalizer calls = %d, want 1", got)
	}
	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("credit settler calls = %d, want 1", got)
	}

	turn := store.snapshotTurn()
	if turn.Status != domainllm.TurnStatusComplete {
		t.Fatalf("turn status = %q, want %q", turn.Status, domainllm.TurnStatusComplete)
	}
}

func TestHandleError_CancelClassificationUsesHardCancelledReason(t *testing.T) {
	t.Parallel()

	executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, domainllm.TurnStatusCancelled)
	setExecutorState(executor, StateStreaming)

	executor.handleError(context.Background(), nil, errors.New("hard cancelled by user"), true)

	if got := executor.getState(); got != StateHardCancelled {
		t.Fatalf("executor state = %v, want %v", got, StateHardCancelled)
	}
	if cleanupCalls.count != 1 {
		t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
	}
	if got := len(store.errorCalls); got != 0 {
		t.Fatalf("UpdateTurnError calls = %d, want 0", got)
	}
	turn := store.snapshotTurn()
	if turn.Status != domainllm.TurnStatusCancelled {
		t.Fatalf("turn status = %q, want %q", turn.Status, domainllm.TurnStatusCancelled)
	}
	if got := finalizer.callCount(); got != 1 {
		t.Fatalf("token finalizer calls = %d, want 1", got)
	}
	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("credit settler calls = %d, want 1", got)
	}
}

func TestHandleError_NonCancelClassificationUsesErrorReason(t *testing.T) {
	t.Parallel()

	executor, store, finalizer, settler, cleanupCalls := newTerminateTestExecutor(t, domainllm.TurnStatusStreaming)
	setExecutorState(executor, StateStreaming)

	executor.handleError(context.Background(), nil, errors.New("provider exploded"), false)

	if got := executor.getState(); got != StateErrored {
		t.Fatalf("executor state = %v, want %v", got, StateErrored)
	}
	if cleanupCalls.count != 1 {
		t.Fatalf("cleanup callback count = %d, want 1", cleanupCalls.count)
	}
	if got := len(store.errorCalls); got != 1 {
		t.Fatalf("UpdateTurnError calls = %d, want 1", got)
	}
	turn := store.snapshotTurn()
	if turn.Status != domainllm.TurnStatusError {
		t.Fatalf("turn status = %q, want %q", turn.Status, domainllm.TurnStatusError)
	}
	if got := finalizer.callCount(); got != 1 {
		t.Fatalf("token finalizer calls = %d, want 1", got)
	}
	if got := settler.settleCallCount(); got != 1 {
		t.Fatalf("credit settler calls = %d, want 1", got)
	}
}

type cleanupCounter struct {
	count int
}

func newTerminateTestExecutor(
	t *testing.T,
	initialTurnStatus domainllm.TurnStatus,
) (*StreamExecutor, *terminateTestStore, *recordingTokenFinalizer, *recordingCreditSettler, *cleanupCounter) {
	t.Helper()

	store := newTerminateTestStore(initialTurnStatus)
	finalizer := newRecordingTokenFinalizer()
	settler := &recordingCreditSettler{}
	cleanupCalls := &cleanupCounter{}

	executor := NewStreamExecutor(
		"test-turn",
		"test-thread",
		"test-user",
		"test-model",
		store,
		store,
		&mockTurnNavigator{},
		nil,
		nil,
		&mockMessageBuilder{},
		slog.Default(),
		&mockCreditAdmissionChecker{},
		settler,
		billing.CreditSettlementInlineAuthoritative,
		5,
		false,
		finalizer,
		nil,
		5,
		nil,
		nil,
	)
	executor.SetCleanupCallback(func() {
		cleanupCalls.count++
	})

	return executor, store, finalizer, settler, cleanupCalls
}

func setExecutorState(executor *StreamExecutor, state ExecutorState) {
	executor.stateMu.Lock()
	defer executor.stateMu.Unlock()
	executor.state = state
}

func terminateTestMetadata() *domainllm.StreamMetadata {
	return &domainllm.StreamMetadata{
		Model:        "test-model",
		InputTokens:  3,
		OutputTokens: 2,
		StopReason:   "end_turn",
	}
}

func cloneTurn(turn *domainllm.Turn) *domainllm.Turn {
	if turn == nil {
		return nil
	}

	cloned := *turn
	if turn.Error != nil {
		errMsg := *turn.Error
		cloned.Error = &errMsg
	}
	if turn.Model != nil {
		model := *turn.Model
		cloned.Model = &model
	}
	if turn.InputTokens != nil {
		input := *turn.InputTokens
		cloned.InputTokens = &input
	}
	if turn.OutputTokens != nil {
		output := *turn.OutputTokens
		cloned.OutputTokens = &output
	}
	if turn.CompletedAt != nil {
		completedAt := *turn.CompletedAt
		cloned.CompletedAt = &completedAt
	}
	return &cloned
}

func cloneCompletionUpdate(update *domainllm.TurnCompletionUpdate) domainllm.TurnCompletionUpdate {
	cloned := domainllm.TurnCompletionUpdate{
		ResponseMetadata: update.ResponseMetadata,
	}
	if update.Model != nil {
		model := *update.Model
		cloned.Model = &model
	}
	if update.StopReason != nil {
		stopReason := *update.StopReason
		cloned.StopReason = &stopReason
	}
	return cloned
}

func assertTurnError(t *testing.T, got *string, want *string) {
	t.Helper()

	switch {
	case got == nil && want == nil:
		return
	case got == nil && want != nil:
		t.Fatalf("turn error = nil, want %q", *want)
	case got != nil && want == nil:
		t.Fatalf("turn error = %q, want nil", *got)
	case *got != *want:
		t.Fatalf("turn error = %q, want %q", *got, *want)
	}
}
