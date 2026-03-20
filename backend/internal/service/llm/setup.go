package llm

import (
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
	llmSvc "meridian/internal/domain/services/llm"
	skillSvc "meridian/internal/domain/services/skill"
	"meridian/internal/jobs"
	docsysSvcImpl "meridian/internal/service/docsystem"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/streaming"
	"meridian/internal/service/llm/thread"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tokens"
	"meridian/internal/service/llm/tools"
)

// SetupProviders initializes the provider factory and registry for routing.
// Returns a configured ProviderRegistry or an error if setup fails.
func SetupProviders(cfg *config.Config, logger *slog.Logger) (*ProviderRegistry, error) {
	// Create provider factory with config (manages API keys, creates providers)
	providerFactory := NewProviderFactory(cfg, logger)

	// Create adapter factory (maps provider names to adapter constructors)
	// Enables adding new providers without modifying existing code (OCP compliance)
	adapterFactory := NewDefaultAdapterFactory()

	// Create registry with both factories (DIP compliance - depends on abstractions)
	registry := NewProviderRegistry(providerFactory, adapterFactory)

	// Validate factories are configured
	if err := registry.Validate(); err != nil {
		return nil, fmt.Errorf("provider registry validation failed: %w", err)
	}

	// Log available providers based on config
	if cfg.AnthropicAPIKey != "" {
		logger.Debug("provider available", "name", "anthropic", "models", "claude-*")
	} else {
		logger.Info("ANTHROPIC_API_KEY not set - Anthropic provider not available")
	}

	// Future: Log other providers when added
	// if cfg.OpenAIAPIKey != "" {
	//     logger.Info("provider available", "name", "openai", "models", "gpt-*, o1-*")
	// }

	logger.Info("provider registry initialized with factory-based routing")

	return registry, nil
}

// Services holds all LLM-related services
type Services struct {
	Thread        llmSvc.ThreadService
	ThreadHistory llmSvc.ThreadHistoryService
	Streaming     llmSvc.StreamingService
}

// SetupServices initializes all LLM services with proper dependency injection
func SetupServices(
	threadRepo llmRepo.ThreadRepository,
	turnRepo llmRepo.TurnRepository,
	projectRepo docsysRepo.ProjectRepository,
	documentRepo docsysRepo.DocumentRepository,
	folderRepo docsysRepo.FolderRepository,
	documentSvc docsysSvc.DocumentService, // For tool write operations (SOLID: DIP)
	folderSvc docsysSvc.FolderService, // For tool write operations (SOLID: DIP)
	skillService skillSvc.ProjectSkillService, // For skill_invoke/skill_list tools
	providerRegistry *ProviderRegistry,
	cfg *config.Config,
	txManager repositories.TransactionManager,
	capabilityRegistry *capabilities.Registry,
	authorizer services.ResourceAuthorizer,
	toolLimitResolver llmSvc.ToolLimitResolver,
	jobQueue jobs.JobQueue,
	mutationStrategy tools.DocumentMutationStrategy, // Strategy for AI edit persistence (collab proposal)
	logger *slog.Logger,
) (*Services, *mstream.Registry, error) {
	// Create shared validator
	validator := NewThreadValidator(threadRepo)

	// Create mstream registry (for SSE streaming)
	streamRegistry := mstream.NewRegistry()

	// Create response generator (uses TurnReader + TurnNavigator for ISP compliance)
	responseGenerator := streaming.NewResponseGenerator(
		providerRegistry,
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements both)
		logger,
	)

	// Create thread service (CRUD only)
	threadService := thread.NewService(
		threadRepo,
		projectRepo,
		logger,
	)

	// Create thread history service (uses TurnReader + TurnNavigator for ISP compliance)
	threadHistoryService := threadhistory.NewService(
		threadRepo,
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements both)
		capabilityRegistry,
		authorizer,
	)

	// Create system prompt resolver
	// Skills content is loaded from DB via skillService (not document repo).
	// Skills metadata is handled by the tool system (skill_invoke metadata enrichment).
	systemPromptResolver := streaming.NewSystemPromptResolver(
		projectRepo,
		threadRepo,
		skillService,
		logger,
	)

	// Create formatter registry and register doc tool formatters
	// str_replace_based_edit_tool handles view (document->text, folder->listing) and edit formatting
	formatterRegistry := formatting.NewFormatterRegistry()
	formatterRegistry.Register("doc_search", &formatting.DocSearchFormatter{})
	formatterRegistry.Register("str_replace_based_edit_tool", &formatting.TextEditorFormatter{})

	// Create MessageBuilder service (pure conversion, no data loading)
	messageBuilder := threadhistory.NewMessageBuilderService(
		formatterRegistry,
		capabilityRegistry,
		logger,
	)

	// Create TokenFinalizer
	// Centralizes token acquisition strategy: provider tokens -> OpenRouter API -> fallback to 0
	// Background enrichment job will update turn tokens asynchronously for cancellations
	tokenFinalizer := tokens.NewDefaultTokenFinalizer(
		cfg.OpenRouterAPIKey,
		logger,
	)

	logger.Info("token finalizer initialized")

	// Create namespace service for document tool routing
	namespaceSvc := docsysSvcImpl.NewNamespaceService(folderRepo, logger)

	// Create streaming service (turn creation/orchestration)
	// Tools are created per-request with project-specific context
	// Uses minimal interfaces (ISP compliance)
	streamingService := streaming.NewService(
		turnRepo, // TurnWriter
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements all three)
		threadRepo,
		projectRepo,  // For validating project access on cold start
		documentSvc,  // For tool operations (SOLID: DIP)
		folderSvc,    // For tool operations (SOLID: DIP)
		namespaceSvc, // For namespace routing in tools
		skillService, // For skill_invoke/skill_list tools
		validator,
		authorizer,
		responseGenerator,
		streamRegistry,
		cfg,
		txManager,
		systemPromptResolver,
		messageBuilder,
		toolLimitResolver,  // Tool round limit resolver (tier-ready)
		capabilityRegistry, // For checking model capabilities (e.g., supports_tools)
		formatterRegistry,  // For formatting synthetic tool results (ref transformer)
		tokenFinalizer,     // For finalizing tokens on completion/interruption
		jobQueue,           // Phase 2: Background job queue for async generation enrichment
		mutationStrategy,   // Strategy for AI edit persistence (collab proposal)
		logger,
	)

	return &Services{
		Thread:        threadService,
		ThreadHistory: threadHistoryService,
		Streaming:     streamingService,
	}, streamRegistry, nil
}
