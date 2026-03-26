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
	domainagents "meridian/internal/domain/agents"
	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/jobs"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
)

// Service implements the StreamingService interface
// Handles turn creation and streaming orchestration
// Uses minimal interfaces (ISP compliance): TurnWriter for creating turns, TurnReader for reading blocks
type Service struct {
	turnWriter             domainllm.TurnWriter
	turnReader             domainllm.TurnReader
	turnNavigator          domainllm.TurnNavigator
	threadRepo             domainllm.ThreadStore
	projectRepo            domaindocsys.ProjectStore     // For validating project access on cold start
	documentSvc            domaindocsys.DocumentService  // For tool operations (SOLID: DIP)
	folderSvc              domaindocsys.FolderService    // For tool operations (SOLID: DIP)
	namespaceSvc           domaindocsys.NamespaceService  // For namespace routing in tools
	skillResolver          domainagents.SkillResolver    // File-backed skill resolution (.agents/skills/)
	validator              ThreadValidator
	authorizer             authdomain.ResourceAuthorizer
	providerGetter         LLMProviderGetter
	registry               *mstream.Registry
	executorRegistry       *ExecutorRegistry             // Tracks StreamExecutors by turn ID for interruption
	interjectionRegistry   *mstream.InterjectionRegistry // Tracks interjection buffers by turn ID
	config                 *config.Config
	txManager              domain.TransactionManager
	systemPromptResolver   domainllm.SystemPromptResolver
	messageBuilder         domainllm.MessageBuilder
	toolLimitResolver      domainllm.ToolLimitResolver    // Resolves tool round limits (tier-ready)
	capabilityRegistry     *capabilities.Registry         // For checking model capabilities (e.g., supports_tools)
	formatterRegistry      *formatting.FormatterRegistry  // For formatting synthetic tool results (ref transformer)
	tokenFinalizer         tokens.TokenFinalizer          // For finalizing tokens on completion/interruption
	creditAdmissionChecker billing.CreditAdmissionChecker // Wired in Phase 4; used by executor in Phase 5
	creditSettler          billing.CreditSettler          // Wired in Phase 4; used by executor in Phase 5
	settlementMode         billing.CreditSettlementMode   // Wired in Phase 4; used by executor in Phase 5
	jobQueue               jobs.JobQueue                  // NEW: Phase 2 - background job queue for async operations
	mutationStrategy       tools.DocumentMutationStrategy // Strategy for AI edit persistence (collab proposal)
	userStreamTracker      *UserStreamTracker             // Per-user concurrent stream limiter
	logger                 *slog.Logger
}

var _ domainllm.StreamingService = (*Service)(nil)

// NewStreamingOrchestrator creates a new streaming service using grouped dependency structs.
// Validates all dependencies at construction time; returns an error if any are missing.
func NewStreamingOrchestrator(deps StreamingDeps) (domainllm.StreamingService, error) {
	if err := deps.Validate(); err != nil {
		return nil, fmt.Errorf("streaming orchestrator deps: %w", err)
	}

	return &Service{
		turnWriter:             deps.Persistence.TurnWriter,
		turnReader:             deps.Persistence.TurnReader,
		turnNavigator:          deps.Persistence.TurnNavigator,
		threadRepo:             deps.Persistence.ThreadRepo,
		projectRepo:            deps.Persistence.ProjectRepo,
		documentSvc:            deps.Services.DocumentSvc,
		folderSvc:              deps.Services.FolderSvc,
		namespaceSvc:           deps.Services.NamespaceSvc,
		skillResolver:          deps.Services.SkillResolver,
		validator:              deps.Services.Validator,
		authorizer:             deps.Services.Authorizer,
		providerGetter:         deps.Pipeline.ProviderGetter,
		registry:               deps.Pipeline.Registry,
		executorRegistry:       NewExecutorRegistry(),
		interjectionRegistry:   mstream.NewInterjectionRegistry(),
		config:                 deps.Infra.Config,
		txManager:              deps.Persistence.TxManager,
		systemPromptResolver:   deps.Pipeline.SystemPromptResolver,
		messageBuilder:         deps.Pipeline.MessageBuilder,
		toolLimitResolver:      deps.Billing.ToolLimitResolver,
		capabilityRegistry:     deps.Pipeline.CapabilityRegistry,
		formatterRegistry:      deps.Pipeline.FormatterRegistry,
		tokenFinalizer:         deps.Billing.TokenFinalizer,
		creditAdmissionChecker: deps.Billing.CreditAdmissionChecker,
		creditSettler:          deps.Billing.CreditSettler,
		settlementMode:         deps.Billing.SettlementMode,
		jobQueue:               deps.Infra.JobQueue,
		mutationStrategy:       deps.Services.MutationStrategy,
		userStreamTracker:      NewUserStreamTracker(deps.Infra.Config.LLM.MaxConcurrentStreamsFree, deps.Infra.Config.LLM.MaxConcurrentStreamsPaid),
		logger:                 deps.Infra.Logger,
	}, nil
}
