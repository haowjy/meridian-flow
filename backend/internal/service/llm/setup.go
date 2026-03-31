package llm

import (
	"fmt"
	"log/slog"
	"meridian/internal/domain"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	domainagents "meridian/internal/domain/agents"
	"meridian/internal/domain/auth"
	"meridian/internal/domain/billing"
	"meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/jobs"
	docsystemsvc "meridian/internal/service/docsystem"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/streaming"
	"meridian/internal/service/llm/thread"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
	"meridian/internal/wsutil"
)

// SetupProviders initializes the provider factory and registry for routing.
func SetupProviders(cfg *config.Config, logger *slog.Logger) (*ProviderRegistry, error) {
	providerFactory := NewProviderFactory(cfg, logger)
	adapterFactory := NewDefaultAdapterFactory()
	registry := NewProviderRegistry(providerFactory, adapterFactory)
	if err := registry.Validate(); err != nil {
		return nil, fmt.Errorf("provider registry validation failed: %w", err)
	}

	if cfg.LLM.AnthropicAPIKey != "" {
		logger.Debug("provider available", "name", "anthropic", "models", "claude-*")
	} else {
		logger.Info("ANTHROPIC_API_KEY not set - Anthropic provider not available")
	}

	logger.Info("provider registry initialized with factory-based routing")
	return registry, nil
}

// Services holds all LLM-related services.
type Services struct {
	Thread        domainllm.ThreadService
	ThreadHistory domainllm.ThreadHistoryService
	Streaming     domainllm.StreamingService
	Spawn         *streaming.SpawnService // Manages child thread lifecycle; nil if not wired
	Interjection  streaming.InterjectionRouter
	Runtime       *streaming.StreamRuntime
	ActiveTurns   streaming.ActiveTurnRegistry
}

// LLMServicesDeps groups dependencies for SetupLLMServices.
type LLMServicesDeps struct {
	ThreadRepo             domainllm.ThreadStore
	TurnRepo               domainllm.TurnStore
	ProjectRepo            docsystem.ProjectStore
	FolderRepo             docsystem.FolderStore
	DocumentSvc            docsystem.DocumentService
	FolderSvc              docsystem.FolderService
	SkillResolver          domainagents.SkillResolver
	ProviderRegistry       *ProviderRegistry
	Config                 *config.Config
	TxManager              domain.TransactionManager
	CapabilityRegistry     *capabilities.Registry
	Authorizer             auth.ResourceAuthorizer
	ToolLimitResolver      domainllm.ToolLimitResolver
	CreditAdmissionChecker billing.CreditAdmissionChecker
	CreditSettler          billing.CreditSettler
	SettlementMode         billing.CreditSettlementMode
	JobQueue               jobs.JobQueue
	MutationStrategy       tools.DocumentMutationStrategy
	ProjectBroadcaster     wsutil.Broadcaster
	Logger                 *slog.Logger
	// WorkItemSvc is optional. When set, threads created without an explicit
	// work_item_id automatically get an ephemeral work item provisioned.
	WorkItemSvc domainwi.Service
	// PersonaCatalog resolves persona profiles from .agents/agents/*.md.
	// Optional: nil disables persona resolution.
	PersonaCatalog domainagents.PersonaCatalog
	// WorkItemStore is used by the streaming pipeline's contextResolver.
	// Optional: nil disables work context resolution.
	WorkItemStore domainwi.Store
}

// Validate checks that all required dependencies are configured.
func (d LLMServicesDeps) Validate() error {
	return validation.ValidateStruct(&d,
		validation.Field(&d.ThreadRepo, validation.Required),
		validation.Field(&d.TurnRepo, validation.Required),
		validation.Field(&d.ProjectRepo, validation.Required),
		validation.Field(&d.FolderRepo, validation.Required),
		validation.Field(&d.DocumentSvc, validation.Required),
		validation.Field(&d.FolderSvc, validation.Required),
		validation.Field(&d.SkillResolver, validation.Required),
		validation.Field(&d.ProviderRegistry, validation.Required),
		validation.Field(&d.Config, validation.Required),
		validation.Field(&d.TxManager, validation.Required),
		validation.Field(&d.CapabilityRegistry, validation.Required),
		validation.Field(&d.Authorizer, validation.Required),
		validation.Field(&d.ToolLimitResolver, validation.Required),
		validation.Field(&d.CreditAdmissionChecker, validation.Required),
		validation.Field(&d.CreditSettler, validation.Required),
		validation.Field(&d.SettlementMode, validation.Required),
		validation.Field(&d.JobQueue, validation.Required),
		validation.Field(&d.MutationStrategy, validation.Required),
		validation.Field(&d.Logger, validation.Required),
	)
}

// SetupLLMServices initializes all LLM services with proper dependency injection.
func SetupLLMServices(deps LLMServicesDeps) (*Services, *mstream.Registry, error) {
	if err := deps.Validate(); err != nil {
		return nil, nil, fmt.Errorf("llm services deps: %w", err)
	}

	validator := NewThreadValidator(deps.ThreadRepo)
	streamRegistry := mstream.NewRegistry()

	// Create a shared ExecutorRegistry so SpawnService can cancel child executors
	// that are running inside the streaming service (cascade cancellation).
	executorRegistry := streaming.NewExecutorRegistry()
	userStreamTracker := streaming.NewUserStreamTracker(
		deps.Config.LLM.MaxConcurrentStreamsFree,
		deps.Config.LLM.MaxConcurrentStreamsPaid,
	)

	providerResolver := streaming.NewProviderResolver(deps.ProviderRegistry)

	threadService := thread.NewService(deps.ThreadRepo, deps.ProjectRepo, deps.WorkItemSvc, deps.Logger)

	threadHistoryService := threadhistory.NewService(
		deps.ThreadRepo,
		deps.TurnRepo,
		deps.TurnRepo,
		deps.CapabilityRegistry,
		deps.Authorizer,
	)

	systemPromptResolver := streaming.NewSystemPromptResolver(deps.ProjectRepo, deps.ThreadRepo, deps.SkillResolver, deps.Logger)

	formatterRegistry := formatting.NewFormatterRegistry()
	formatterRegistry.Register("doc_search", &formatting.DocSearchFormatter{})
	formatterRegistry.Register("str_replace_based_edit_tool", &formatting.TextEditorFormatter{})

	messageBuilder := threadhistory.NewMessageBuilderService(formatterRegistry, deps.CapabilityRegistry, deps.Logger)

	tokenFinalizer := tokens.NewDefaultTokenFinalizer(deps.Config.LLM.OpenRouterAPIKey, deps.Logger)
	deps.Logger.Info("token finalizer initialized")

	namespaceSvc := docsystemsvc.NewNamespaceService(deps.FolderRepo, deps.Logger)
	var spawnInvoker domainllm.SpawnInvoker
	turnContextResolver := streaming.NewTurnContextResolver(streaming.TurnContextResolverDeps{
		TurnReader:             deps.TurnRepo,
		ThreadRepo:             deps.ThreadRepo,
		ProjectRepo:            deps.ProjectRepo,
		Validator:              validator,
		PersonaCatalog:         deps.PersonaCatalog,
		WorkItemSvc:            deps.WorkItemSvc,
		WorkItemStore:          deps.WorkItemStore,
		CreditAdmissionChecker: deps.CreditAdmissionChecker,
		UserStreamTracker:      userStreamTracker,
		CapabilityRegistry:     deps.CapabilityRegistry,
		Config:                 deps.Config,
		TxManager:              deps.TxManager,
		Logger:                 deps.Logger,
	})

	toolRegistryFactory := streaming.NewToolRegistryFactory(streaming.ToolRegistryFactoryDeps{
		NamespaceSvc:     namespaceSvc,
		MutationStrategy: deps.MutationStrategy,
		DocumentSvc:      deps.DocumentSvc,
		FolderSvc:        deps.FolderSvc,
		SkillResolver:    deps.SkillResolver,
		SpawnInvokerRef: func() domainllm.SpawnInvoker {
			return spawnInvoker
		},
		Config: deps.Config,
		Logger: deps.Logger,
	})

	streamRequestBuilder := streaming.NewStreamRequestBuilder(streaming.StreamRequestBuilderDeps{
		TurnNavigator:     deps.TurnRepo,
		TurnReader:        deps.TurnRepo,
		MessageBuilder:    messageBuilder,
		DocumentSvc:       deps.DocumentSvc,
		FolderSvc:         deps.FolderSvc,
		FormatterRegistry: formatterRegistry,
		Logger:            deps.Logger,
	})

	interjectionRouter := streaming.NewInterjectionForwarder()

	// Build TokenMonitor for context budget tracking (autocollapse at 60%, warn at 90%).
	// Non-fatal if estimator creation fails — monitoring is optional; turns proceed normally.
	var tokenMonitor *streaming.TokenMonitor
	tokenEst, estErr := tokens.NewTiktokenEstimator(deps.CapabilityRegistry)
	if estErr != nil {
		deps.Logger.Warn("failed to create token estimator; context budget monitoring disabled",
			"error", estErr,
		)
	} else {
		tokenMonitor = streaming.NewTokenMonitor(tokenEst, deps.Logger)
	}

	streamRuntime := streaming.NewStreamRuntime(streaming.StreamRuntimeDeps{
		ProviderGetter:     providerResolver,
		StreamRegistry:     streamRegistry,
		ExecutorRegistry:   executorRegistry,
		InterjectionRouter: interjectionRouter,
		ToolLimitResolver:  deps.ToolLimitResolver,
		RequestBuilder:     streamRequestBuilder,
		ThreadRepo:         deps.ThreadRepo,
		TxManager:          deps.TxManager,
		ExecutorDeps: streaming.ExecutorDeps{
			TurnWriter:             deps.TurnRepo,
			TurnReader:             deps.TurnRepo,
			TurnNavigator:          deps.TurnRepo,
			MessageBuilder:         messageBuilder,
			CreditAdmissionChecker: deps.CreditAdmissionChecker,
			CreditSettler:          deps.CreditSettler,
			TokenFinalizer:         tokenFinalizer,
			JobQueue:               deps.JobQueue,
			TokenMonitor:           tokenMonitor,
		},
		Broadcaster: deps.ProjectBroadcaster,
		Config:      deps.Config,
		Logger:      deps.Logger,
	})

	streamingService, err := streaming.NewStreamingOrchestrator(streaming.StreamingDeps{
		Persistence: streaming.PersistenceDeps{
			TurnWriter:  deps.TurnRepo,
			TurnReader:  deps.TurnRepo,
			ThreadRepo:  deps.ThreadRepo,
			ProjectRepo: deps.ProjectRepo,
			TxManager:   deps.TxManager,
		},
		Services: streaming.ServiceDeps{
			TurnContextResolver:  turnContextResolver,
			ToolRegistryFactory:  toolRegistryFactory,
			StreamRequestBuilder: streamRequestBuilder,
			StreamRuntime:        streamRuntime,
			InterjectionRouter:   interjectionRouter,
			Validator:            validator,
			Authorizer:           deps.Authorizer,
		},
		Pipeline: streaming.PipelineDeps{
			Registry:             streamRegistry,
			SystemPromptResolver: systemPromptResolver,
			CapabilityRegistry:   deps.CapabilityRegistry,
		},
		Billing: streaming.BillingDeps{
			SettlementMode: deps.SettlementMode,
		},
		Infra: streaming.InfraDeps{
			Config:           deps.Config,
			Logger:           deps.Logger,
			ExecutorRegistry: executorRegistry, // shared with SpawnService for cascade cancel
			Broadcaster:      deps.ProjectBroadcaster,
		},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create streaming service: %w", err)
	}

	// Wire SpawnService: bootstrapper depends on streamingService (CreateTurn path),
	// and SpawnService depends on the shared executorRegistry for executor-level cancellation.
	// The circular dependency is broken by a SpawnInvokerRef closure captured above.
	bootstrapper := streaming.NewChildThreadBootstrapper(streamingService, deps.TurnRepo, deps.Logger)
	spawnSvc := streaming.NewSpawnService(
		deps.ThreadRepo,
		deps.TxManager,
		deps.Config,
		bootstrapper,
		executorRegistry,
		deps.ProjectBroadcaster,
		deps.Logger,
	)

	// Wire SpawnInvoker back into the closure so spawn_agent can call CreateSpawn.
	spawnInvoker = spawnSvc

	return &Services{
		Thread:        threadService,
		ThreadHistory: threadHistoryService,
		Streaming:     streamingService,
		Spawn:         spawnSvc,
		Interjection:  interjectionRouter,
		Runtime:       streamRuntime,
		ActiveTurns:   executorRegistry,
	}, streamRegistry, nil
}
