package streaming

// pipeline_stages_test.go — Unit tests for the R1 pipeline decomposition.
//
// Focus areas:
//  1. Pipeline stage isolation: each stage tested independently with mock inputs
//  2. Cold-start vs warm-start: thread creation in gatherContext, NOT in persistTurns
//  3. Error propagation: each stage properly propagates errors
//  4. ExecTx split: thread creation (gatherContext) vs turn creation (persistTurns)
//
// Key regression guard: the cold-start bug where resolveSystemPromptForParams was called
// with threadID="" because thread creation happened inside the persistTurns ExecTx rather
// than before assemblePrompt. After the fix, gatherContext creates the thread first.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"testing"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// =============================================================================
// Mock implementations for pipeline stage testing
// (named *ForPipeline to avoid conflicts with mocks in executor_test.go)
// =============================================================================

// mockTxManagerForPipeline executes the tx function inline (simulates successful tx).
// Tracks how many times ExecTx was invoked.
type mockTxManagerForPipeline struct {
	execCalled int
	returnErr  error
}

func (m *mockTxManagerForPipeline) ExecTx(ctx context.Context, fn domain.TxFn) error {
	m.execCalled++
	if m.returnErr != nil {
		return m.returnErr
	}
	return fn(ctx)
}

var _ domain.TransactionManager = (*mockTxManagerForPipeline)(nil)

// mockThreadStoreForPipeline tracks CreateThread calls and controls return values.
// The idToAssign field simulates the DB assigning a UUID on insert.
type mockThreadStoreForPipeline struct {
	createThreadCalls int
	createThreadErr   error
	idToAssign        string // ID assigned to thread on CreateThread (simulates DB UUID gen)

	returnGetThread *domainllm.Thread // Returned by GetThread; nil uses default
	returnGetErr    error
}

func (m *mockThreadStoreForPipeline) CreateThread(ctx context.Context, thread *domainllm.Thread) error {
	m.createThreadCalls++
	if m.createThreadErr != nil {
		return m.createThreadErr
	}
	if m.idToAssign != "" {
		thread.ID = m.idToAssign
	}
	return nil
}

func (m *mockThreadStoreForPipeline) GetThread(ctx context.Context, threadID, userID string) (*domainllm.Thread, error) {
	if m.returnGetErr != nil {
		return nil, m.returnGetErr
	}
	if m.returnGetThread != nil {
		return m.returnGetThread, nil
	}
	return &domainllm.Thread{ID: threadID, ProjectID: "proj-default"}, nil
}

func (m *mockThreadStoreForPipeline) GetThreadByIDOnly(ctx context.Context, threadID string) (*domainllm.Thread, error) {
	return nil, nil
}
func (m *mockThreadStoreForPipeline) ListThreadsByProject(ctx context.Context, projectID, userID string) ([]domainllm.Thread, error) {
	return nil, nil
}
func (m *mockThreadStoreForPipeline) UpdateThread(ctx context.Context, thread *domainllm.Thread) error {
	return nil
}
func (m *mockThreadStoreForPipeline) UpdateLastViewedTurn(ctx context.Context, threadID, userID string, turnID *string) error {
	return nil
}
func (m *mockThreadStoreForPipeline) DeleteThread(ctx context.Context, threadID, userID string) (*domainllm.Thread, error) {
	return nil, nil
}
func (m *mockThreadStoreForPipeline) GetThreadTree(ctx context.Context, threadID, userID string) (*domainllm.ThreadTree, error) {
	return nil, nil
}
func (m *mockThreadStoreForPipeline) UpdateSpawnStatus(ctx context.Context, threadID string, status domainllm.SpawnStatus, spawnResult *json.RawMessage) error {
	return nil
}
func (m *mockThreadStoreForPipeline) CountRunningSpawnsByWorkItem(ctx context.Context, workItemID string) (int, error) {
	return 0, nil
}
func (m *mockThreadStoreForPipeline) ListChildThreads(ctx context.Context, parentThreadID string) ([]domainllm.Thread, error) {
	return nil, nil
}

var _ domainllm.ThreadStore = (*mockThreadStoreForPipeline)(nil)

// mockProjectStoreForPipeline returns a configurable project or error.
type mockProjectStoreForPipeline struct {
	returnProject *domaindocsys.Project
	returnErr     error
	touchCalled   int
}

func (m *mockProjectStoreForPipeline) GetByID(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	if m.returnErr != nil {
		return nil, m.returnErr
	}
	if m.returnProject != nil {
		return m.returnProject, nil
	}
	return &domaindocsys.Project{ID: id, UserID: userID}, nil
}

func (m *mockProjectStoreForPipeline) GetByIDOnly(ctx context.Context, id string) (*domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStoreForPipeline) Create(ctx context.Context, project *domaindocsys.Project) error {
	return nil
}
func (m *mockProjectStoreForPipeline) GetBySlug(ctx context.Context, slug, userID string) (*domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStoreForPipeline) SlugExists(ctx context.Context, slug, userID string, excludeID *string) (bool, error) {
	return false, nil
}
func (m *mockProjectStoreForPipeline) List(ctx context.Context, userID string) ([]domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStoreForPipeline) Update(ctx context.Context, project *domaindocsys.Project) error {
	return nil
}
func (m *mockProjectStoreForPipeline) Delete(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	return nil, nil
}
func (m *mockProjectStoreForPipeline) TouchLastActivityAt(ctx context.Context, projectID string) error {
	m.touchCalled++
	return nil
}

var _ domaindocsys.ProjectStore = (*mockProjectStoreForPipeline)(nil)

// mockValidatorForPipeline returns a fixed error (or nil) for all thread validation.
type mockValidatorForPipeline struct {
	validateErr error
}

func (m *mockValidatorForPipeline) ValidateThread(_ context.Context, _, _ string) error {
	return m.validateErr
}

var _ ThreadValidator = (*mockValidatorForPipeline)(nil)

// mockTurnReaderForPipeline returns a turn by ID or an error.
type mockTurnReaderForPipeline struct {
	returnTurn *domainllm.Turn
	returnErr  error
}

func (m *mockTurnReaderForPipeline) GetTurn(_ context.Context, turnID string) (*domainllm.Turn, error) {
	if m.returnErr != nil {
		return nil, m.returnErr
	}
	if m.returnTurn != nil {
		return m.returnTurn, nil
	}
	return &domainllm.Turn{ID: turnID, ThreadID: "thread-from-reader"}, nil
}
func (m *mockTurnReaderForPipeline) GetRootTurns(_ context.Context, _ string) ([]domainllm.Turn, error) {
	return nil, nil
}
func (m *mockTurnReaderForPipeline) GetTurnBlocks(_ context.Context, _ string) ([]domainllm.TurnBlock, error) {
	return nil, nil
}
func (m *mockTurnReaderForPipeline) GetTurnBlocksForTurns(_ context.Context, _ []string) (map[string][]domainllm.TurnBlock, error) {
	return nil, nil
}
func (m *mockTurnReaderForPipeline) GetLastBlockSequence(_ context.Context, _ string) (int, error) {
	return -1, nil
}

var _ domainllm.TurnReader = (*mockTurnReaderForPipeline)(nil)

// mockTurnWriterForPipeline tracks CreateTurn calls and auto-assigns sequential IDs.
// ID assignment is critical: persistTurns sets assistantTurn.PrevTurnID = &userTurn.ID,
// so CreateTurn must populate userTurn.ID before the assistant turn is built.
type mockTurnWriterForPipeline struct {
	createTurnCalls int
	createTurnErr   error
	idSeq           int
}

func (m *mockTurnWriterForPipeline) CreateTurn(_ context.Context, turn *domainllm.Turn) error {
	if m.createTurnErr != nil {
		return m.createTurnErr
	}
	m.idSeq++
	turn.ID = fmt.Sprintf("turn-%d", m.idSeq)
	m.createTurnCalls++
	return nil
}

func (m *mockTurnWriterForPipeline) CreateTurnBlock(_ context.Context, _ *domainllm.TurnBlock) error {
	return nil
}
func (m *mockTurnWriterForPipeline) CreateTurnBlocks(_ context.Context, _ []domainllm.TurnBlock) error {
	return nil
}
func (m *mockTurnWriterForPipeline) UpdateTurnStatus(_ context.Context, _ string, _ domainllm.TurnStatus, _ *domainllm.Turn) error {
	return nil
}
func (m *mockTurnWriterForPipeline) UpdateTurn(_ context.Context, _ *domainllm.Turn) error {
	return nil
}
func (m *mockTurnWriterForPipeline) UpdateTurnMetadata(_ context.Context, _ string, _ map[string]interface{}) error {
	return nil
}
func (m *mockTurnWriterForPipeline) UpdateTurnError(_ context.Context, _ string, _ string) error {
	return nil
}
func (m *mockTurnWriterForPipeline) UpsertPartialBlock(_ context.Context, _ *domainllm.TurnBlock) error {
	return nil
}
func (m *mockTurnWriterForPipeline) AccumulateTokensAndUpdateMetadata(_ context.Context, _ string, _ *domainllm.TurnTokenUpdate, _ *domainllm.TurnCompletionUpdate) error {
	return nil
}
func (m *mockTurnWriterForPipeline) AppendGenerationRecord(_ context.Context, _ string, _ *domainllm.GenerationRecord) error {
	return nil
}

var _ domainllm.TurnWriter = (*mockTurnWriterForPipeline)(nil)

// =============================================================================
// Helpers
// =============================================================================

// newTestConfig returns a minimal config suitable for pipeline stage tests.
func newTestConfig() *config.Config {
	return &config.Config{
		LLM: config.LLMConfig{
			DefaultModel:             "moonshotai/kimi-k2-thinking",
			MaxToolRounds:            10,
			MaxConcurrentStreamsFree: 100,
			MaxConcurrentStreamsPaid: 100,
		},
	}
}

// newTestCapabilityRegistry returns a real capabilities registry (fail-open for unknown models).
func newTestCapabilityRegistry(t *testing.T) *capabilities.Registry {
	t.Helper()
	reg, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("capabilities.NewRegistry() failed: %v", err)
	}
	return reg
}

// buildServiceForGatherContext builds a minimal Service suitable for testing TurnContextResolver.
// Does NOT include components needed by assemblePrompt/launchStream.
func buildServiceForGatherContext(
	t *testing.T,
	threadStore *mockThreadStoreForPipeline,
	projectStore *mockProjectStoreForPipeline,
	validator *mockValidatorForPipeline,
	turnReader *mockTurnReaderForPipeline,
	txManager *mockTxManagerForPipeline,
) *Service {
	t.Helper()
	userStreamTracker := NewUserStreamTracker(100, 100)
	turnContextResolver := NewTurnContextResolver(TurnContextResolverDeps{
		TurnReader:             turnReader,
		ThreadRepo:             threadStore,
		ProjectRepo:            projectStore,
		Validator:              validator,
		CreditAdmissionChecker: &mockCreditAdmissionChecker{},
		UserStreamTracker:      userStreamTracker,
		CapabilityRegistry:     newTestCapabilityRegistry(t),
		Config:                 newTestConfig(),
		TxManager:              txManager,
		Logger:                 slog.Default(),
	})

	return &Service{
		threadRepo:          threadStore,
		projectRepo:         projectStore,
		validator:           validator,
		turnReader:          turnReader,
		txManager:           txManager,
		config:              newTestConfig(),
		capabilityRegistry:  newTestCapabilityRegistry(t),
		turnContextResolver: turnContextResolver,
		logger:              slog.Default(),
	}
}

// strPtr is a convenience helper for *string literals.
func strPtr(s string) *string { return &s }

// =============================================================================
// Tests: resolveThreadContext — stage 1 branching logic
// =============================================================================

// TestResolveThreadContext_PrevTurnID verifies that when PrevTurnID is provided,
// the thread is resolved from the turn (warm-start, isNewThread=false).
func TestResolveThreadContext_PrevTurnID(t *testing.T) {
	prevTurnID := "prev-turn-abc"
	threadID := "thread-from-reader"
	projectID := "proj-xyz"

	threadStore := &mockThreadStoreForPipeline{
		returnGetThread: &domainllm.Thread{
			ID:        threadID,
			ProjectID: projectID,
		},
	}
	turnReader := &mockTurnReaderForPipeline{
		// GetTurn returns a turn with ThreadID set
		returnTurn: &domainllm.Turn{ID: prevTurnID, ThreadID: threadID},
	}

	svc := buildServiceForGatherContext(t, threadStore, &mockProjectStoreForPipeline{},
		&mockValidatorForPipeline{}, turnReader, &mockTxManagerForPipeline{})

	req := &domainllm.CreateTurnRequest{
		UserID:     "user-1",
		PrevTurnID: strPtr(prevTurnID),
	}

	tc, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err != nil {
		t.Fatalf("resolveThreadContext() unexpected error: %v", err)
	}

	if tc.threadID != threadID {
		t.Errorf("threadID = %q, want %q", tc.threadID, threadID)
	}
	if tc.isNewThread {
		t.Error("isNewThread = true, want false (warm start via PrevTurnID)")
	}
}

// TestResolveThreadContext_ThreadID verifies that when ThreadID is provided directly,
// the existing thread is used (warm-start, isNewThread=false).
func TestResolveThreadContext_ThreadID(t *testing.T) {
	threadID := "thread-warm-start"
	projectID := "proj-warm"

	threadStore := &mockThreadStoreForPipeline{
		returnGetThread: &domainllm.Thread{ID: threadID, ProjectID: projectID},
	}

	svc := buildServiceForGatherContext(t, threadStore, &mockProjectStoreForPipeline{},
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, &mockTxManagerForPipeline{})

	req := &domainllm.CreateTurnRequest{
		UserID:   "user-1",
		ThreadID: strPtr(threadID),
	}

	tc, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err != nil {
		t.Fatalf("resolveThreadContext() unexpected error: %v", err)
	}

	if tc.threadID != threadID {
		t.Errorf("threadID = %q, want %q", tc.threadID, threadID)
	}
	if tc.projectID != projectID {
		t.Errorf("projectID = %q, want %q", tc.projectID, projectID)
	}
	if tc.isNewThread {
		t.Error("isNewThread = true, want false (warm start via ThreadID)")
	}
}

// TestResolveThreadContext_ProjectID_ColdStart verifies that when only ProjectID is
// provided (no thread), a cold-start context is returned with isNewThread=true
// and threadID="" (thread not yet created — that happens in gatherContext).
func TestResolveThreadContext_ProjectID_ColdStart(t *testing.T) {
	projectID := "proj-cold-start"

	projectStore := &mockProjectStoreForPipeline{
		returnProject: &domaindocsys.Project{ID: projectID, UserID: "user-1"},
	}

	svc := buildServiceForGatherContext(t, &mockThreadStoreForPipeline{}, projectStore,
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, &mockTxManagerForPipeline{})

	req := &domainllm.CreateTurnRequest{
		UserID:    "user-1",
		ProjectID: strPtr(projectID),
	}

	tc, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err != nil {
		t.Fatalf("resolveThreadContext() unexpected error: %v", err)
	}

	if !tc.isNewThread {
		t.Error("isNewThread = false, want true (cold start via ProjectID)")
	}
	if tc.threadID != "" {
		t.Errorf("threadID = %q, want empty (not yet created)", tc.threadID)
	}
	if tc.projectID != projectID {
		t.Errorf("projectID = %q, want %q", tc.projectID, projectID)
	}
}

// TestResolveThreadContext_NoID_ValidationError verifies that providing neither
// PrevTurnID, ThreadID, nor ProjectID returns a validation error.
func TestResolveThreadContext_NoID_ValidationError(t *testing.T) {
	svc := buildServiceForGatherContext(t,
		&mockThreadStoreForPipeline{},
		&mockProjectStoreForPipeline{},
		&mockValidatorForPipeline{},
		&mockTurnReaderForPipeline{},
		&mockTxManagerForPipeline{},
	)

	req := &domainllm.CreateTurnRequest{UserID: "user-1"}
	// All of ThreadID, ProjectID, PrevTurnID are nil

	_, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err == nil {
		t.Fatal("resolveThreadContext() expected error, got nil")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Errorf("error type = %T(%v), want domain.ErrValidation", err, err)
	}
}

// TestResolveThreadContext_PrevTurnID_NotFound verifies error propagation when
// the turn referenced by PrevTurnID doesn't exist.
func TestResolveThreadContext_PrevTurnID_NotFound(t *testing.T) {
	turnReader := &mockTurnReaderForPipeline{
		returnErr: domain.NewNotFoundError("turn", "turn not found"),
	}

	svc := buildServiceForGatherContext(t,
		&mockThreadStoreForPipeline{},
		&mockProjectStoreForPipeline{},
		&mockValidatorForPipeline{},
		turnReader,
		&mockTxManagerForPipeline{},
	)

	req := &domainllm.CreateTurnRequest{
		UserID:     "user-1",
		PrevTurnID: strPtr("nonexistent-turn"),
	}

	_, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err == nil {
		t.Fatal("resolveThreadContext() expected error, got nil")
	}
}

// TestResolveThreadContext_ThreadID_ValidateFails verifies error propagation when
// ValidateThread rejects the thread (e.g. deleted or not accessible by user).
func TestResolveThreadContext_ThreadID_ValidateFails(t *testing.T) {
	validationErr := errors.New("thread deleted or inaccessible")
	validator := &mockValidatorForPipeline{validateErr: validationErr}

	svc := buildServiceForGatherContext(t,
		&mockThreadStoreForPipeline{},
		&mockProjectStoreForPipeline{},
		validator,
		&mockTurnReaderForPipeline{},
		&mockTxManagerForPipeline{},
	)

	req := &domainllm.CreateTurnRequest{
		UserID:   "user-1",
		ThreadID: strPtr("thread-deleted"),
	}

	_, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err == nil {
		t.Fatal("resolveThreadContext() expected validation error, got nil")
	}
	if !errors.Is(err, validationErr) {
		t.Errorf("error = %v, want %v", err, validationErr)
	}
}

// TestResolveThreadContext_ProjectID_ProjectNotAccessible verifies error propagation
// when the project referenced for cold start is inaccessible.
func TestResolveThreadContext_ProjectID_ProjectNotAccessible(t *testing.T) {
	projectStore := &mockProjectStoreForPipeline{
		returnErr: domain.NewNotFoundError("project", "project not found"),
	}

	svc := buildServiceForGatherContext(t,
		&mockThreadStoreForPipeline{},
		projectStore,
		&mockValidatorForPipeline{},
		&mockTurnReaderForPipeline{},
		&mockTxManagerForPipeline{},
	)

	req := &domainllm.CreateTurnRequest{
		UserID:    "user-1",
		ProjectID: strPtr("proj-inaccessible"),
	}

	_, err := svc.turnContextResolver.ResolveThreadContext(context.Background(), req)
	if err == nil {
		t.Fatal("resolveThreadContext() expected error for inaccessible project, got nil")
	}
}

// =============================================================================
// Tests: gatherContext cold-start vs warm-start — the ExecTx split
//
// The core regression guard for R1: thread creation must happen in gatherContext
// (before assemblePrompt), NOT inside persistTurns. This ensures resolveSystemPromptForParams
// always receives a non-empty threadID, fixing the cold-start bug.
// =============================================================================

// TestGatherContext_ColdStart_CreatesThreadBeforeAssemblePrompt verifies that on cold
// start (ProjectID-only request), gatherContext creates the thread via ExecTx so
// that threadCtx.threadID is populated before assemblePrompt would run.
//
// Regression: Previously, thread creation was inside persistTurns ExecTx, so
// resolveSystemPromptForParams received threadID="" on cold start.
func TestGatherContext_ColdStart_CreatesThreadBeforeAssemblePrompt(t *testing.T) {
	const assignedThreadID = "new-thread-uuid-123"
	projectID := "proj-cold-abc"

	threadStore := &mockThreadStoreForPipeline{
		idToAssign: assignedThreadID,
	}
	projectStore := &mockProjectStoreForPipeline{
		returnProject: &domaindocsys.Project{ID: projectID, UserID: "user-1"},
	}
	txManager := &mockTxManagerForPipeline{}

	svc := buildServiceForGatherContext(t, threadStore, projectStore,
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, txManager)

	text := "Hello, start a new story"
	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID:    "user-1",
			ProjectID: strPtr(projectID),
			Role:      "user",
			TurnBlocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &text},
			},
		},
	}

	turnCtx, err := svc.turnContextResolver.Resolve(context.Background(), p.req)
	if err != nil {
		t.Fatalf("Resolve() unexpected error: %v", err)
	}
	p.turnCtx = turnCtx

	// Thread must be created (cold start)
	if threadStore.createThreadCalls != 1 {
		t.Errorf("CreateThread calls = %d, want 1", threadStore.createThreadCalls)
	}

	// threadCtx.threadID must be non-empty after gatherContext
	// (so assemblePrompt can call resolveSystemPromptForParams with a valid ID)
	if p.turnCtx.ThreadCtx.threadID == "" {
		t.Error("threadCtx.threadID is empty after cold-start gatherContext — this is the bug we fixed")
	}
	if p.turnCtx.ThreadCtx.threadID != assignedThreadID {
		t.Errorf("threadCtx.threadID = %q, want %q", p.turnCtx.ThreadCtx.threadID, assignedThreadID)
	}

	// createdThread must be populated so launchStream can skip the extra GetThread call
	if p.turnCtx.CreatedThread == nil {
		t.Error("createdThread is nil after cold-start gatherContext")
	}
	if p.turnCtx.CreatedThread.ID != assignedThreadID {
		t.Errorf("createdThread.ID = %q, want %q", p.turnCtx.CreatedThread.ID, assignedThreadID)
	}

	// isNewThread must be set so the response can include the created thread
	if !p.turnCtx.ThreadCtx.isNewThread {
		t.Error("threadCtx.isNewThread = false, want true (cold start)")
	}
}

// TestGatherContext_WarmStart_NoThreadCreation verifies that on warm start
// (ThreadID provided), gatherContext does NOT create a new thread.
//
// Regression guard: thread creation should only happen on cold start.
func TestGatherContext_WarmStart_NoThreadCreation(t *testing.T) {
	threadID := "existing-thread-456"
	projectID := "proj-warm-789"

	threadStore := &mockThreadStoreForPipeline{
		returnGetThread: &domainllm.Thread{ID: threadID, ProjectID: projectID},
	}
	projectStore := &mockProjectStoreForPipeline{
		returnProject: &domaindocsys.Project{ID: projectID, UserID: "user-1"},
	}
	txManager := &mockTxManagerForPipeline{}

	svc := buildServiceForGatherContext(t, threadStore, projectStore,
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, txManager)

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID:   "user-1",
			ThreadID: strPtr(threadID),
			Role:     "user",
		},
	}

	turnCtx, err := svc.turnContextResolver.Resolve(context.Background(), p.req)
	if err != nil {
		t.Fatalf("Resolve() unexpected error: %v", err)
	}
	p.turnCtx = turnCtx

	// No thread creation on warm start
	if threadStore.createThreadCalls != 0 {
		t.Errorf("CreateThread calls = %d, want 0 (warm start must not create thread)", threadStore.createThreadCalls)
	}

	// createdThread must be nil on warm start
	if p.turnCtx.CreatedThread != nil {
		t.Error("createdThread is non-nil on warm start — should only be set on cold start")
	}

	// threadCtx must use the existing thread ID
	if p.turnCtx.ThreadCtx.threadID != threadID {
		t.Errorf("threadCtx.threadID = %q, want %q", p.turnCtx.ThreadCtx.threadID, threadID)
	}

	if p.turnCtx.ThreadCtx.isNewThread {
		t.Error("threadCtx.isNewThread = true on warm start")
	}
}

// TestGatherContext_ColdStart_CreateThreadError verifies that if thread creation
// fails in gatherContext, the error is propagated and no further processing occurs.
func TestGatherContext_ColdStart_CreateThreadError(t *testing.T) {
	projectID := "proj-failing-create"
	createErr := errors.New("database connection failed")

	threadStore := &mockThreadStoreForPipeline{
		createThreadErr: createErr,
	}
	projectStore := &mockProjectStoreForPipeline{
		returnProject: &domaindocsys.Project{ID: projectID, UserID: "user-1"},
	}
	txManager := &mockTxManagerForPipeline{}

	svc := buildServiceForGatherContext(t, threadStore, projectStore,
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, txManager)

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID:    "user-1",
			ProjectID: strPtr(projectID),
			Role:      "user",
		},
	}

	turnCtx, err := svc.turnContextResolver.Resolve(context.Background(), p.req)
	if err == nil {
		t.Fatal("Resolve() expected error on thread creation failure, got nil")
	}

	// The error must wrap the original
	if !errors.Is(err, createErr) {
		t.Errorf("error = %v, want wrapping %v", err, createErr)
	}

	// threadCtx.threadID must remain empty — the thread was never created
	if turnCtx != nil && turnCtx.ThreadCtx != nil && turnCtx.ThreadCtx.threadID != "" {
		t.Errorf("threadCtx.threadID = %q after create failure, want empty", turnCtx.ThreadCtx.threadID)
	}
}

// TestGatherContext_ColdStart_TitleFromFirstTextBlock verifies that the thread title
// is derived from the first text block of the request (not hardcoded "New Thread").
func TestGatherContext_ColdStart_TitleFromFirstTextBlock(t *testing.T) {
	const assignedID = "new-thread-title-test"
	projectID := "proj-title"

	var capturedThread *domainllm.Thread
	// Use a custom thread store to capture the created thread
	threadStore := &mockThreadStoreForPipeline{
		idToAssign: assignedID,
	}
	// Override CreateThread to capture the thread argument
	// (We do this via a wrapper since mockThreadStoreForPipeline's CreateThread already sets ID)
	_ = capturedThread // used below via threadStore

	projectStore := &mockProjectStoreForPipeline{
		returnProject: &domaindocsys.Project{ID: projectID, UserID: "user-1"},
	}

	svc := buildServiceForGatherContext(t, threadStore, projectStore,
		&mockValidatorForPipeline{}, &mockTurnReaderForPipeline{}, &mockTxManagerForPipeline{})

	text := "Write a fantasy story about dragons"
	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID:    "user-1",
			ProjectID: strPtr(projectID),
			Role:      "user",
			TurnBlocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &text},
			},
		},
	}

	turnCtx, err := svc.turnContextResolver.Resolve(context.Background(), p.req)
	if err != nil {
		t.Fatalf("Resolve() unexpected error: %v", err)
	}
	p.turnCtx = turnCtx

	if p.turnCtx.CreatedThread == nil {
		t.Fatal("createdThread is nil")
	}
	// Title should be the first N words of the text block, not "New Thread"
	if p.turnCtx.CreatedThread.Title == "New Thread" {
		t.Error("thread title is 'New Thread' — should be derived from turn block content")
	}
	if p.turnCtx.CreatedThread.Title == "" {
		t.Error("thread title is empty")
	}
}

// =============================================================================
// Tests: persistTurns — stage 3, ExecTx split
//
// persistTurns must NOT create the thread (that moved to gatherContext).
// It should only create user turn + blocks + assistant turn in one transaction.
// =============================================================================

// TestPersistTurns_NoThreadCreation verifies that persistTurns does NOT call
// CreateThread — thread creation belongs to gatherContext (the ExecTx split).
func TestPersistTurns_NoThreadCreation(t *testing.T) {
	txManager := &mockTxManagerForPipeline{}
	threadStore := &mockThreadStoreForPipeline{} // track CreateThread
	turnWriter := &mockTurnWriterForPipeline{}
	projectStore := &mockProjectStoreForPipeline{}

	svc := &Service{
		txManager:   txManager,
		threadRepo:  threadStore,
		turnWriter:  turnWriter,
		projectRepo: projectStore,
		logger:      slog.Default(),
	}

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID: "user-1",
			Role:   "user",
		},
		turnCtx: &TurnContext{
			ThreadCtx: &threadContext{
				threadID:    "thread-already-created",
				projectID:   "proj-123",
				isNewThread: true, // simulates cold start — but thread was already created in gatherContext
			},
			RequestParams: map[string]interface{}{},
			Model:         "test-model",
			Provider:      "openrouter",
		},
	}

	if err := p.persistTurns(context.Background()); err != nil {
		t.Fatalf("persistTurns() unexpected error: %v", err)
	}

	// persistTurns must NOT call CreateThread — that's gatherContext's job
	if threadStore.createThreadCalls != 0 {
		t.Errorf("CreateThread calls = %d, want 0 (persistTurns must not create threads)", threadStore.createThreadCalls)
	}
}

// TestPersistTurns_CreatesUserAndAssistantTurns verifies that persistTurns creates
// exactly two turns (user + assistant) in a single transaction, and that the
// assistant turn's PrevTurnID points to the user turn.
func TestPersistTurns_CreatesUserAndAssistantTurns(t *testing.T) {
	txManager := &mockTxManagerForPipeline{}
	turnWriter := &mockTurnWriterForPipeline{}
	projectStore := &mockProjectStoreForPipeline{}

	svc := &Service{
		txManager:   txManager,
		turnWriter:  turnWriter,
		projectRepo: projectStore,
		logger:      slog.Default(),
	}

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID: "user-1",
			Role:   "user",
		},
		turnCtx: &TurnContext{
			ThreadCtx: &threadContext{
				threadID:  "thread-persist-test",
				projectID: "proj-persist",
			},
			RequestParams: map[string]interface{}{},
			Model:         "test-model",
			Provider:      "openrouter",
		},
	}

	if err := p.persistTurns(context.Background()); err != nil {
		t.Fatalf("persistTurns() unexpected error: %v", err)
	}

	// Both user and assistant turns must be created
	if turnWriter.createTurnCalls != 2 {
		t.Errorf("CreateTurn calls = %d, want 2 (user + assistant)", turnWriter.createTurnCalls)
	}

	// Output turns must be populated
	if p.userTurn == nil {
		t.Fatal("userTurn is nil after persistTurns")
	}
	if p.assistantTurn == nil {
		t.Fatal("assistantTurn is nil after persistTurns")
	}

	// Assistant must follow user
	if p.assistantTurn.PrevTurnID == nil {
		t.Error("assistantTurn.PrevTurnID is nil — must point to userTurn")
	} else if *p.assistantTurn.PrevTurnID != p.userTurn.ID {
		t.Errorf("assistantTurn.PrevTurnID = %q, want userTurn.ID %q",
			*p.assistantTurn.PrevTurnID, p.userTurn.ID)
	}

	// Roles must be correct
	if p.userTurn.Role != "user" {
		t.Errorf("userTurn.Role = %q, want user", p.userTurn.Role)
	}
	if p.assistantTurn.Role != "assistant" {
		t.Errorf("assistantTurn.Role = %q, want assistant", p.assistantTurn.Role)
	}

	// Assistant starts streaming
	if p.assistantTurn.Status != domainllm.TurnStatusStreaming {
		t.Errorf("assistantTurn.Status = %v, want streaming", p.assistantTurn.Status)
	}

	// Transaction ran once
	if txManager.execCalled != 1 {
		t.Errorf("ExecTx calls = %d, want 1", txManager.execCalled)
	}
}

// TestPersistTurns_WithContentBlocks verifies that content blocks from the request
// are persisted alongside the user turn.
func TestPersistTurns_WithContentBlocks(t *testing.T) {
	turnWriter := &mockTurnWriterForPipeline{}
	projectStore := &mockProjectStoreForPipeline{}

	svc := &Service{
		txManager:   &mockTxManagerForPipeline{},
		turnWriter:  turnWriter,
		projectRepo: projectStore,
		logger:      slog.Default(),
	}

	text := "Write chapter 1"
	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{
			UserID: "user-1",
			Role:   "user",
			TurnBlocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &text},
			},
		},
		turnCtx: &TurnContext{
			ThreadCtx: &threadContext{
				threadID:  "thread-blocks-test",
				projectID: "proj-blocks",
			},
			RequestParams: map[string]interface{}{},
			Model:         "test-model",
		},
	}

	if err := p.persistTurns(context.Background()); err != nil {
		t.Fatalf("persistTurns() unexpected error: %v", err)
	}

	// Blocks should be attached to the user turn
	if p.userTurn == nil {
		t.Fatal("userTurn is nil")
	}
	if len(p.userTurn.Blocks) != 1 {
		t.Errorf("userTurn.Blocks len = %d, want 1", len(p.userTurn.Blocks))
	}
	if p.userTurn.Blocks[0].BlockType != "text" {
		t.Errorf("block type = %q, want text", p.userTurn.Blocks[0].BlockType)
	}
}

// TestPersistTurns_TurnWriterError_Propagates verifies that a CreateTurn error
// propagates out of persistTurns and the pipeline sees it.
func TestPersistTurns_TurnWriterError_Propagates(t *testing.T) {
	dbErr := errors.New("unique constraint violation")
	turnWriter := &mockTurnWriterForPipeline{createTurnErr: dbErr}

	svc := &Service{
		txManager:   &mockTxManagerForPipeline{},
		turnWriter:  turnWriter,
		projectRepo: &mockProjectStoreForPipeline{},
		logger:      slog.Default(),
	}

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{UserID: "user-1", Role: "user"},
		turnCtx: &TurnContext{
			ThreadCtx: &threadContext{
				threadID:  "thread-error-test",
				projectID: "proj-err",
			},
			RequestParams: map[string]interface{}{},
			Model:         "test-model",
		},
	}

	err := p.persistTurns(context.Background())
	if err == nil {
		t.Fatal("persistTurns() expected error from turnWriter, got nil")
	}
	if !errors.Is(err, dbErr) {
		t.Errorf("error = %v, want wrapping %v", err, dbErr)
	}
}

// TestPersistTurns_UsesResolvedThreadID verifies that the turns are stored with
// the thread ID that was set by gatherContext — not a blank ID.
//
// This is the other half of the cold-start bug: persistTurns must use
// p.threadCtx.threadID which gatherContext populated, not create its own.
func TestPersistTurns_UsesResolvedThreadID(t *testing.T) {
	const resolvedThreadID = "thread-resolved-by-gather-context"
	turnWriter := &mockTurnWriterForPipeline{}

	svc := &Service{
		txManager:   &mockTxManagerForPipeline{},
		turnWriter:  turnWriter,
		projectRepo: &mockProjectStoreForPipeline{},
		logger:      slog.Default(),
	}

	p := &turnPipeline{
		svc: svc,

		req: &domainllm.CreateTurnRequest{UserID: "user-1", Role: "user"},
		turnCtx: &TurnContext{
			ThreadCtx: &threadContext{
				threadID:  resolvedThreadID, // Pre-populated by gatherContext
				projectID: "proj-resolved",
			},
			RequestParams: map[string]interface{}{},
			Model:         "test-model",
		},
	}

	if err := p.persistTurns(context.Background()); err != nil {
		t.Fatalf("persistTurns() unexpected error: %v", err)
	}

	if p.userTurn.ThreadID != resolvedThreadID {
		t.Errorf("userTurn.ThreadID = %q, want %q", p.userTurn.ThreadID, resolvedThreadID)
	}
	if p.assistantTurn.ThreadID != resolvedThreadID {
		t.Errorf("assistantTurn.ThreadID = %q, want %q", p.assistantTurn.ThreadID, resolvedThreadID)
	}
}

// =============================================================================
// Tests: deriveTitleFromTurnBlocks — utility for cold-start thread naming
// =============================================================================

func TestDeriveTitleFromTurnBlocks(t *testing.T) {
	longText := "In the beginning there was darkness and then light came from the void"
	first := "First message content"
	second := "Second message content"
	empty := ""
	plainText := "Hello world this is my story"

	tests := []struct {
		name   string
		blocks []domainllm.TurnBlockInput
		want   string
	}{
		{name: "empty blocks fall back to default title", want: "New Thread"},
		{
			name: "non-text blocks are ignored",
			blocks: []domainllm.TurnBlockInput{
				{BlockType: "tool_use", Content: map[string]interface{}{"name": "something"}},
			},
			want: "New Thread",
		},
		{
			name: "first text block becomes the title",
			blocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &plainText},
			},
			want: plainText,
		},
		{
			name: "long text is truncated to the configured word limit",
			blocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &longText},
			},
			want: "In the beginning there was darkness",
		},
		{
			name: "empty text content falls back to default title",
			blocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &empty},
			},
			want: "New Thread",
		},
		{
			name: "only the first text block contributes",
			blocks: []domainllm.TurnBlockInput{
				{BlockType: "text", TextContent: &first},
				{BlockType: "text", TextContent: &second},
			},
			want: first,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title := deriveTitleFromTurnBlocks(tt.blocks)
			if title != tt.want {
				t.Fatalf("deriveTitleFromTurnBlocks() = %q, want %q", title, tt.want)
			}
			if words := len(splitWords(title)); words > defaultTitleMaxWords {
				t.Fatalf("title has %d words, want at most %d: %q", words, defaultTitleMaxWords, title)
			}
		})
	}
}

// =============================================================================
// Tests: resolveSettlementMode — billing mode selection
// =============================================================================

func TestResolveSettlementMode(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		settlementMode billing.CreditSettlementMode
		want           string
	}{
		{name: "openrouter uses deferred settlement", provider: "openrouter", want: "deferred_to_enrichment"},
		{name: "anthropic uses inline settlement", provider: "anthropic", want: "inline_authoritative"},
		{name: "unknown provider uses configured service default", provider: "some-unknown-provider", settlementMode: "inline_authoritative", want: "inline_authoritative"},
		{name: "unknown provider falls back when no service default exists", provider: "some-unknown-provider", want: "inline_authoritative"},
		{name: "provider matching is case insensitive", provider: "OpenRouter", want: "deferred_to_enrichment"},
		{name: "provider matching trims whitespace", provider: " openrouter ", want: "deferred_to_enrichment"},
		{name: "anthropic matching is case insensitive", provider: "ANTHROPIC", want: "inline_authoritative"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &Service{settlementMode: tt.settlementMode}
			mode := svc.resolveSettlementMode(tt.provider)
			if string(mode) != tt.want {
				t.Fatalf("resolveSettlementMode(%q) = %q, want %q", tt.provider, mode, tt.want)
			}
		})
	}
}

// =============================================================================
// Tests: validateCreateTurnRequest — validation helpers
// =============================================================================

func TestValidateCreateTurnRequest(t *testing.T) {
	svc := &Service{logger: slog.Default()}

	tests := []struct {
		name    string
		req     *domainllm.CreateTurnRequest
		wantErr bool
	}{
		{name: "role is required", req: &domainllm.CreateTurnRequest{}, wantErr: true},
		{name: "assistant role is rejected", req: &domainllm.CreateTurnRequest{Role: "assistant"}, wantErr: true},
		{name: "user role is valid", req: &domainllm.CreateTurnRequest{Role: "user"}},
		{
			name: "invalid block type is rejected",
			req: &domainllm.CreateTurnRequest{
				Role: "user",
				TurnBlocks: []domainllm.TurnBlockInput{
					{BlockType: "invalid_type"},
				},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := svc.validateCreateTurnRequest(tt.req)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateCreateTurnRequest() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// =============================================================================
// Helper: splitWords avoids importing strings in test logic
// =============================================================================

func splitWords(s string) []string {
	var words []string
	word := ""
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' {
			if word != "" {
				words = append(words, word)
				word = ""
			}
		} else {
			word += string(r)
		}
	}
	if word != "" {
		words = append(words, word)
	}
	return words
}
