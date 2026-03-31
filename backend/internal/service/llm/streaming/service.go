package streaming

import (
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	billing "meridian/internal/domain/billing"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
)

// Service implements the StreamingService interface
// Handles turn creation and streaming orchestration
// Uses minimal interfaces (ISP compliance): TurnWriter for creating turns, TurnReader for reading blocks
type Service struct {
	turnWriter           domainllm.TurnWriter
	turnReader           domainllm.TurnReader
	threadRepo           domainllm.ThreadStore
	projectRepo          domaindocsys.ProjectStore // For validating project access on cold start
	turnContextResolver  *TurnContextResolver      // Owns stage-1 context resolution
	toolRegistryFactory  *ToolRegistryFactory      // Builds prompt/execution tool registries
	streamRequestBuilder *StreamRequestBuilder     // Builds conversation messages for LLM
	streamRuntime        *StreamRuntime            // Owns stream/executor launch lifecycle
	validator            ThreadValidator
	authorizer           authdomain.ResourceAuthorizer
	registry             *mstream.Registry
	executorRegistry     *ExecutorRegistry // Tracks StreamExecutors by turn ID for interruption
	interjectionRouter   InterjectionRouter
	config               *config.Config
	txManager            domain.TransactionManager
	systemPromptResolver domainllm.SystemPromptResolver
	capabilityRegistry   *capabilities.Registry       // For checking model capabilities (e.g., supports_tools)
	settlementMode       billing.CreditSettlementMode // Wired in Phase 4; used by executor in Phase 5
	logger               *slog.Logger
}

var _ domainllm.StreamingService = (*Service)(nil)

// NewStreamingOrchestrator creates a new streaming service using grouped dependency structs.
// Validates all dependencies at construction time; returns an error if any are missing.
func NewStreamingOrchestrator(deps StreamingDeps) (domainllm.StreamingService, error) {
	if err := deps.Validate(); err != nil {
		return nil, fmt.Errorf("streaming orchestrator deps: %w", err)
	}

	// Use the provided executor registry if one was injected (shared with SpawnService
	// for cross-component cancellation), otherwise create a new private one.
	execRegistry := deps.Infra.ExecutorRegistry
	if execRegistry == nil {
		execRegistry = NewExecutorRegistry()
	}

	return &Service{
		turnWriter:           deps.Persistence.TurnWriter,
		turnReader:           deps.Persistence.TurnReader,
		threadRepo:           deps.Persistence.ThreadRepo,
		projectRepo:          deps.Persistence.ProjectRepo,
		turnContextResolver:  deps.Services.TurnContextResolver,
		toolRegistryFactory:  deps.Services.ToolRegistryFactory,
		streamRequestBuilder: deps.Services.StreamRequestBuilder,
		streamRuntime:        deps.Services.StreamRuntime,
		validator:            deps.Services.Validator,
		authorizer:           deps.Services.Authorizer,
		registry:             deps.Pipeline.Registry,
		executorRegistry:     execRegistry,
		interjectionRouter:   deps.Services.InterjectionRouter,
		config:               deps.Infra.Config,
		txManager:            deps.Persistence.TxManager,
		systemPromptResolver: deps.Pipeline.SystemPromptResolver,
		capabilityRegistry:   deps.Pipeline.CapabilityRegistry,
		settlementMode:       deps.Billing.SettlementMode,
		logger:               deps.Infra.Logger,
	}, nil
}
