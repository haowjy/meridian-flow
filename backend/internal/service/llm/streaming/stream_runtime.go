package streaming

import (
	"context"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
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
	providerGetter       LLMProviderGetter
	streamRegistry       *mstream.Registry
	executorRegistry     *ExecutorRegistry
	interjectionRegistry *mstream.InterjectionRegistry
	toolLimitResolver    domainllm.ToolLimitResolver
	requestBuilder       *StreamRequestBuilder
	threadRepo           domainllm.ThreadStore // For bookmark update on stream switch
	executorDeps         ExecutorDeps
	config               *config.Config
	logger               *slog.Logger
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
	ProviderGetter       LLMProviderGetter
	StreamRegistry       *mstream.Registry
	ExecutorRegistry     *ExecutorRegistry
	InterjectionRegistry *mstream.InterjectionRegistry
	ToolLimitResolver    domainllm.ToolLimitResolver
	RequestBuilder       *StreamRequestBuilder
	ThreadRepo           domainllm.ThreadStore // For bookmark update on stream switch
	ExecutorDeps         ExecutorDeps
	Config               *config.Config
	Logger               *slog.Logger
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
	StreamSwitchFn StreamSwitchFn
}

func NewStreamRuntime(deps StreamRuntimeDeps) *StreamRuntime {
	return &StreamRuntime{
		providerGetter:       deps.ProviderGetter,
		streamRegistry:       deps.StreamRegistry,
		executorRegistry:     deps.ExecutorRegistry,
		interjectionRegistry: deps.InterjectionRegistry,
		toolLimitResolver:    deps.ToolLimitResolver,
		requestBuilder:       deps.RequestBuilder,
		threadRepo:           deps.ThreadRepo,
		executorDeps:         deps.ExecutorDeps,
		config:               deps.Config,
		logger:               deps.Logger,
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

	interjectionBuffer := r.interjectionRegistry.GetOrCreate(input.AssistantTurn.ID)

	executor := NewStreamExecutor(
		input.AssistantTurn.ID,
		input.ThreadID,
		input.UserID,
		input.Model,
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
		interjectionBuffer,
		input.StreamSwitchFn,
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
		r.interjectionRegistry.Remove(turnID)
		if streamRegistered {
			r.streamRegistry.Remove(turnID)
		}
		if releaseStreamSlot != nil {
			releaseStreamSlot()
		}
		r.logger.Debug("executor cleaned up from registry", "turn_id", turnID)
	})

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
		if updateErr := r.executorDeps.TurnWriter.UpdateTurnError(ctx, assistantTurnID, fmt.Sprintf("failed to build conversation messages: %v", err)); updateErr != nil {
			r.logger.Error("failed to update turn error", "error", updateErr)
		}
		// Cleanup: executor was registered but never started — manually run cleanup
		// to release stream slot and remove from executor registry. Without this,
		// a failed pre-start leaves a phantom stream that blocks the user's slot.
		executor.RunCleanup()
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

// CreateStreamSwitchFn builds a StreamSwitchFn for interjection injection.
// createTurnFn is injected to avoid a StreamRuntime -> Service circular dependency.
func (r *StreamRuntime) CreateStreamSwitchFn(
	threadID,
	userID string,
	requestParams map[string]any,
	createTurnFn func(ctx context.Context, req *domainllm.CreateTurnRequest) (*domainllm.CreateTurnResponse, error),
) StreamSwitchFn {
	return func(ctx context.Context, currentAssistantTurnID string, interjection string, reason string) (*StreamSwitchResult, error) {
		r.logger.Info("stream switch triggered",
			"current_turn_id", currentAssistantTurnID,
			"reason", reason,
			"interjection_length", len(interjection),
		)

		if err := r.executorDeps.TurnWriter.UpdateTurnStatus(ctx, currentAssistantTurnID, domainllm.TurnStatusComplete, nil); err != nil {
			r.logger.Error("failed to complete current turn during stream switch",
				"turn_id", currentAssistantTurnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to complete current turn: %w", err)
		}

		textContent := interjection
		resp, err := createTurnFn(ctx, &domainllm.CreateTurnRequest{
			ThreadID:   &threadID,
			PrevTurnID: &currentAssistantTurnID,
			UserID:     userID,
			Role:       "user",
			TurnBlocks: []domainllm.TurnBlockInput{
				{
					BlockType:   "text",
					TextContent: &textContent,
				},
			},
			RequestParams: requestParams,
		})
		if err != nil {
			r.logger.Error("failed to create follow-up turn during stream switch",
				"current_turn_id", currentAssistantTurnID,
				"error", err,
			)
			return nil, fmt.Errorf("failed to create follow-up turn: %w", err)
		}

		// Advance bookmark so reload/reconnect anchors on the new assistant turn,
		// not the old one that was just completed.
		if err := r.threadRepo.UpdateLastViewedTurn(ctx, threadID, userID, &resp.AssistantTurn.ID); err != nil {
			r.logger.Warn("failed to update last_viewed_turn_id after stream switch",
				"thread_id", threadID,
				"new_turn_id", resp.AssistantTurn.ID,
				"error", err,
			)
			// Non-fatal: stream switch succeeded, bookmark is a UX convenience
		}

		r.logger.Info("stream switch completed",
			"prev_turn_id", currentAssistantTurnID,
			"new_user_turn_id", resp.UserTurn.ID,
			"new_assistant_turn_id", resp.AssistantTurn.ID,
			"reason", reason,
		)

		r.interjectionRegistry.Remove(currentAssistantTurnID)

		return &StreamSwitchResult{
			UserTurn:      resp.UserTurn,
			AssistantTurn: resp.AssistantTurn,
			StreamURL:     resp.StreamURL,
		}, nil
	}
}
