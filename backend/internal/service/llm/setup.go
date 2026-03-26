package llm

import (
	"fmt"
	"log/slog"
	"meridian/internal/domain"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain/auth"
	"meridian/internal/domain/billing"
	domainagents "meridian/internal/domain/agents"
	"meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/jobs"
	docsystemsvc "meridian/internal/service/docsystem"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/streaming"
	"meridian/internal/service/llm/thread"
	"meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
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
	Logger                 *slog.Logger
	// WorkItemSvc is optional. When set, threads created without an explicit
	// work_item_id automatically get an ephemeral work item provisioned.
	WorkItemSvc domainwi.Service
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

	streamingService, err := streaming.NewStreamingOrchestrator(streaming.StreamingDeps{
		Persistence: streaming.PersistenceDeps{
			TurnWriter:    deps.TurnRepo,
			TurnReader:    deps.TurnRepo,
			TurnNavigator: deps.TurnRepo,
			ThreadRepo:    deps.ThreadRepo,
			ProjectRepo:   deps.ProjectRepo,
			TxManager:     deps.TxManager,
		},
		Services: streaming.ServiceDeps{
			DocumentSvc:      deps.DocumentSvc,
			FolderSvc:        deps.FolderSvc,
			NamespaceSvc:     namespaceSvc,
			SkillResolver:    deps.SkillResolver,
			Validator:        validator,
			Authorizer:       deps.Authorizer,
			MutationStrategy: deps.MutationStrategy,
		},
		Pipeline: streaming.PipelineDeps{
			ProviderGetter:       providerResolver,
			Registry:             streamRegistry,
			SystemPromptResolver: systemPromptResolver,
			MessageBuilder:       messageBuilder,
			CapabilityRegistry:   deps.CapabilityRegistry,
			FormatterRegistry:    formatterRegistry,
		},
		Billing: streaming.BillingDeps{
			ToolLimitResolver:      deps.ToolLimitResolver,
			TokenFinalizer:         tokenFinalizer,
			CreditAdmissionChecker: deps.CreditAdmissionChecker,
			CreditSettler:          deps.CreditSettler,
			SettlementMode:         deps.SettlementMode,
		},
		Infra: streaming.InfraDeps{
			Config:   deps.Config,
			JobQueue: deps.JobQueue,
			Logger:   deps.Logger,
		},
	})
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create streaming service: %w", err)
	}

	return &Services{
		Thread:        threadService,
		ThreadHistory: threadHistoryService,
		Streaming:     streamingService,
	}, streamRegistry, nil
}
