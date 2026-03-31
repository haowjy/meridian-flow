package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
	"meridian/internal/domain"
	billing "meridian/internal/domain/billing"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
)

// StreamRuntime creates StreamExecutors, registers them, and starts background streaming.
// Executor dependencies are grouped under ExecutorDeps to avoid threading many service fields
// through turnPipeline stage 4.
type StreamRuntime struct {
	providerGetter     LLMProviderGetter
	streamRegistry     *mstream.Registry
	executorRegistry   *ExecutorRegistry
	interjectionRouter InterjectionRouter
	toolLimitResolver  domainllm.ToolLimitResolver
	requestBuilder     *StreamRequestBuilder
	threadRepo         domainllm.ThreadStore // For bookmark update on stream switch
	txManager          domain.TransactionManager
	executorDeps       ExecutorDeps
	config             *config.Config
	logger             *slog.Logger
}

// ExecutorDeps groups dependencies that are passed through directly to NewStreamExecutor.
type ExecutorDeps struct {
	TurnWriter             domainllm.TurnWriter
	TurnReader             domainllm.TurnReader
	TurnNavigator          domainllm.TurnNavigator
	MessageBuilder         domainllm.MessageBuilder
	CreditAdmissionChecker billing.CreditAdmissionChecker
	CreditSettler          billing.CreditSettler
	TokenFinalizer         tokens.TokenFinalizer
	JobQueue               jobs.JobQueue
	TokenMonitor           *TokenMonitor
}

// StreamRuntimeDeps groups dependencies for StreamRuntime construction.
type StreamRuntimeDeps struct {
	ProviderGetter     LLMProviderGetter
	StreamRegistry     *mstream.Registry
	ExecutorRegistry   *ExecutorRegistry
	InterjectionRouter InterjectionRouter
	ToolLimitResolver  domainllm.ToolLimitResolver
	RequestBuilder     *StreamRequestBuilder
	ThreadRepo         domainllm.ThreadStore // For bookmark update on stream switch
	TxManager          domain.TransactionManager
	ExecutorDeps       ExecutorDeps
	Config             *config.Config
	Logger             *slog.Logger
}

// LaunchInput captures all request-scoped data needed to launch assistant streaming.
type LaunchInput struct {
	AssistantTurn  *domainllm.Turn
	UserTurn       *domainllm.Turn
	Thread         *domainllm.Thread
	ThreadID       string
	UserID         string
	ProjectID      string
	Model          string
	Provider       string
	Params         *domainllm.RequestParams
	ToolRegistry   *tools.ToolRegistry
	SettlementMode billing.CreditSettlementMode
}

// SwitchStreamInput captures request-scoped data for atomic stream switching.
type SwitchStreamInput struct {
	CurrentTurnID    string
	ThreadID         string
	UserID           string
	ProjectID        string
	Model            string
	Provider         string
	Params           *domainllm.RequestParams
	ToolRegistry     *tools.ToolRegistry
	SettlementMode   billing.CreditSettlementMode
	InterjectionText string
	Reason           string
	ReleaseSlot      func()
}

// StreamSwitchResult contains the newly created turns from a stream switch.
type StreamSwitchResult struct {
	UserTurn      *domainllm.Turn
	AssistantTurn *domainllm.Turn
	StreamURL     string
}

func NewStreamRuntime(deps StreamRuntimeDeps) *StreamRuntime {
	return &StreamRuntime{
		providerGetter:     deps.ProviderGetter,
		streamRegistry:     deps.StreamRegistry,
		executorRegistry:   deps.ExecutorRegistry,
		interjectionRouter: deps.InterjectionRouter,
		toolLimitResolver:  deps.ToolLimitResolver,
		requestBuilder:     deps.RequestBuilder,
		threadRepo:         deps.ThreadRepo,
		txManager:          deps.TxManager,
		executorDeps:       deps.ExecutorDeps,
		config:             deps.Config,
		logger:             deps.Logger,
	}
}

// GetProvider resolves an LLM provider by name. Exposed for debug endpoint.
func (r *StreamRuntime) GetProvider(provider string) (domainllm.LLMProvider, error) {
	return r.providerGetter.GetProvider(provider)
}

// Launch creates an executor, registers the stream/executor, wires cleanup, and starts
// background streaming execution.
func (r *StreamRuntime) Launch(ctx context.Context, input *LaunchInput, releaseStreamSlot func()) (*domainllm.CreateTurnResponse, error) {
	llmProvider, err := r.providerGetter.GetProvider(input.Provider)
	if err != nil {
		r.logger.Error("failed to get provider for streaming",
			"error", err,
			"provider", input.Provider,
			"model", input.Model,
			"assistant_turn_id", input.AssistantTurn.ID,
		)
		if updateErr := r.executorDeps.TurnWriter.UpdateTurnError(ctx, input.AssistantTurn.ID, fmt.Sprintf("failed to get provider: %v", err)); updateErr != nil {
			r.logger.Error("failed to update turn error", "error", updateErr)
		}
		return nil, fmt.Errorf("failed to get provider '%s': %w", input.Provider, err)
	}

	toolRoundLimit, err := r.toolLimitResolver.GetToolRoundLimit(ctx, input.UserID)
	if err != nil {
		r.logger.Warn("failed to get tool round limit, using config default",
			"error", err,
			"user_id", input.UserID,
			"fallback_limit", r.config.LLM.MaxToolRounds,
		)
		toolRoundLimit = r.config.LLM.MaxToolRounds
	}

	r.interjectionRouter.Register(input.AssistantTurn.ID)

	executor := NewStreamExecutor(
		input.AssistantTurn.ID,
		input.ThreadID,
		input.UserID,
		input.ProjectID,
		input.Model,
		input.Provider,
		r.executorDeps.TurnWriter,
		r.executorDeps.TurnReader,
		r.executorDeps.TurnNavigator,
		llmProvider,
		input.ToolRegistry,
		r.executorDeps.MessageBuilder,
		r.logger,
		r.executorDeps.CreditAdmissionChecker,
		r.executorDeps.CreditSettler,
		input.SettlementMode,
		toolRoundLimit,
		r.config.Server.Debug,
		r.executorDeps.TokenFinalizer,
		r.executorDeps.JobQueue,
		r.config.LLM.SoftCancelTimeoutSeconds,
		r.interjectionRouter,
		r,
	)

	if r.executorDeps.TokenMonitor != nil {
		executor.SetTokenMonitor(r.executorDeps.TokenMonitor)
	}

	stream := executor.GetStream()
	streamRegistered := true
	if err := r.streamRegistry.Register(stream); err != nil {
		streamRegistered = false
		r.logger.Warn("failed to register stream", "turn_id", input.AssistantTurn.ID, "error", err)
	}

	turnID := input.AssistantTurn.ID
	executor.SetCleanupCallback(func() {
		r.executorRegistry.Remove(turnID)
		r.interjectionRouter.Remove(turnID)
		if streamRegistered {
			r.streamRegistry.Remove(turnID)
		}
		r.logger.Debug("executor cleaned up from registry", "turn_id", turnID)
	})
	executor.SetSlotRelease(releaseStreamSlot)

	r.executorRegistry.Register(input.AssistantTurn.ID, executor)

	r.logger.Debug("stream registered, starting background streaming",
		"assistant_turn_id", input.AssistantTurn.ID,
		"model", input.Model,
	)

	// Use context.Background() so stream execution survives HTTP request cancellation.
	go r.startStreamingExecution(
		context.Background(),
		input.AssistantTurn.ID,
		input.UserTurn.ID,
		input.UserID,
		input.ProjectID,
		executor,
		input.Params,
	)

	streamURL := fmt.Sprintf("/api/turns/%s/stream", input.AssistantTurn.ID)
	return &domainllm.CreateTurnResponse{
		Thread:        input.Thread,
		UserTurn:      input.UserTurn,
		AssistantTurn: input.AssistantTurn,
		StreamURL:     streamURL,
	}, nil
}

// startStreamingExecution prepares the request and starts executor streaming.
// Runs in a background goroutine.
func (r *StreamRuntime) startStreamingExecution(ctx context.Context, assistantTurnID, userTurnID, userID, projectID string, executor *StreamExecutor, params *domainllm.RequestParams) {
	r.logger.Debug("preparing streaming request",
		"assistant_turn_id", assistantTurnID,
	)

	messages, err := r.requestBuilder.BuildConversationMessages(ctx, userTurnID, userID, projectID)
	if err != nil {
		r.logger.Error("failed to build conversation messages for streaming",
			"error", err,
			"user_turn_id", userTurnID,
		)
		// Pre-start failure: terminate directly instead of manual cleanup so all
		// terminalization steps run (status, tokens/billing hooks, AG-UI, cleanup).
		executor.Terminate(ReasonError, TerminateOpts{
			ErrorMessage: fmt.Sprintf("failed to build conversation messages: %v", err),
		})
		return
	}

	generateReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    executor.model,
		Params:   params,
	}

	executor.Start(generateReq)

	r.logger.Info("streaming execution started",
		"assistant_turn_id", assistantTurnID,
		"model", executor.model,
	)
}

// SwitchStream atomically persists follow-up turns and launches a successor
// stream without acquiring a new stream slot.
func (r *StreamRuntime) SwitchStream(ctx context.Context, input *SwitchStreamInput) (*StreamSwitchResult, error) {
	if input == nil {
		return nil, fmt.Errorf("switch stream input is required")
	}
	if input.ReleaseSlot == nil {
		return nil, fmt.Errorf("switch stream release slot callback is required")
	}
	switchFailed := true
	defer func() {
		// Slot release ownership is transferred into SwitchStream. On any failure,
		// release immediately so the user does not leak a stream slot.
		if switchFailed && input.ReleaseSlot != nil {
			input.ReleaseSlot()
		}
	}()

	r.logger.Info("stream switch triggered",
		"current_turn_id", input.CurrentTurnID,
		"reason", input.Reason,
		"interjection_length", len(input.InterjectionText),
	)

	if r.txManager == nil {
		return nil, fmt.Errorf("transaction manager is required for stream switching")
	}

	var (
		userTurn      *domainllm.Turn
		assistantTurn *domainllm.Turn
	)
	err := r.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		var persistErr error
		userTurn, assistantTurn, persistErr = r.persistSwitchTurns(txCtx, input)
		if persistErr != nil {
			return persistErr
		}

		return r.executorDeps.TurnWriter.UpdateTurnStatus(txCtx, input.CurrentTurnID, domainllm.TurnStatusComplete, &domainllm.Turn{
			ResponseMetadata: map[string]interface{}{
				"successor_turn_id": assistantTurn.ID,
			},
		})
	})
	if err != nil {
		r.logger.Error("failed to persist stream switch transaction",
			"turn_id", input.CurrentTurnID,
			"error", err,
		)
		return nil, fmt.Errorf("failed to persist stream switch transaction: %w", err)
	}

	resp, err := r.Launch(ctx, &LaunchInput{
		AssistantTurn:  assistantTurn,
		UserTurn:       userTurn,
		ThreadID:       input.ThreadID,
		UserID:         input.UserID,
		ProjectID:      input.ProjectID,
		Model:          input.Model,
		Provider:       input.Provider,
		Params:         input.Params,
		ToolRegistry:   input.ToolRegistry,
		SettlementMode: input.SettlementMode,
	}, input.ReleaseSlot)
	if err != nil {
		return nil, fmt.Errorf("failed to launch switched stream: %w", err)
	}

	// Advance bookmark so reload/reconnect anchors on the new assistant turn,
	// not the old one that was just completed.
	if r.threadRepo != nil {
		if err := r.threadRepo.UpdateLastViewedTurn(ctx, input.ThreadID, input.UserID, &assistantTurn.ID); err != nil {
			r.logger.Warn("failed to update last_viewed_turn_id after stream switch",
				"thread_id", input.ThreadID,
				"new_turn_id", assistantTurn.ID,
				"error", err,
			)
			// Non-fatal: stream switch succeeded, bookmark is a UX convenience.
		}
	}

	r.logger.Info("stream switch completed",
		"prev_turn_id", input.CurrentTurnID,
		"new_user_turn_id", userTurn.ID,
		"new_assistant_turn_id", assistantTurn.ID,
		"reason", input.Reason,
	)
	switchFailed = false

	return &StreamSwitchResult{
		UserTurn:      resp.UserTurn,
		AssistantTurn: resp.AssistantTurn,
		StreamURL:     resp.StreamURL,
	}, nil
}

func (r *StreamRuntime) persistSwitchTurns(ctx context.Context, input *SwitchStreamInput) (*domainllm.Turn, *domainllm.Turn, error) {
	requestParams, err := requestParamsToMap(input.Params)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to convert request params: %w", err)
	}

	var (
		userTurn      *domainllm.Turn
		assistantTurn *domainllm.Turn
	)
	now := time.Now().UTC()
	userTurn = &domainllm.Turn{
		ThreadID:      input.ThreadID,
		PrevTurnID:    ptrString(input.CurrentTurnID),
		Role:          domainllm.TurnRoleUser,
		Status:        domainllm.TurnStatusComplete,
		RequestParams: cloneAnyMap(requestParams),
		CreatedAt:     now,
	}
	if err := r.executorDeps.TurnWriter.CreateTurn(ctx, userTurn); err != nil {
		return nil, nil, fmt.Errorf("failed to create switch user turn: %w", err)
	}

	textContent := input.InterjectionText
	userBlocks := []domainllm.TurnBlock{
		{
			TurnID:      userTurn.ID,
			BlockType:   domainllm.BlockTypeText,
			Sequence:    0,
			TextContent: &textContent,
			CreatedAt:   now,
		},
	}
	if err := r.executorDeps.TurnWriter.CreateTurnBlocks(ctx, userBlocks); err != nil {
		return nil, nil, fmt.Errorf("failed to create switch user blocks: %w", err)
	}
	userTurn.Blocks = userBlocks

	assistantTurn = &domainllm.Turn{
		ThreadID:      input.ThreadID,
		PrevTurnID:    &userTurn.ID,
		Role:          domainllm.TurnRoleAssistant,
		Status:        domainllm.TurnStatusStreaming,
		Model:         ptrString(input.Model),
		RequestParams: cloneAnyMap(requestParams),
		CreatedAt:     now,
	}
	if err := r.executorDeps.TurnWriter.CreateTurn(ctx, assistantTurn); err != nil {
		return nil, nil, fmt.Errorf("failed to create switch assistant turn: %w", err)
	}

	return userTurn, assistantTurn, nil
}

func requestParamsToMap(params *domainllm.RequestParams) (map[string]any, error) {
	if params == nil {
		return nil, nil
	}

	encoded, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	if len(decoded) == 0 {
		return nil, nil
	}
	return decoded, nil
}

func cloneAnyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
