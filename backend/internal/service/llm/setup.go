package llm

import (
	"context"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	"meridian/internal/config"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/domain/services"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/streaming"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/thread"
	"meridian/internal/service/llm/tokens"
)

// SetupProviders initializes the provider factory and registry for routing.
// Returns a configured ProviderRegistry or an error if setup fails.
func SetupProviders(cfg *config.Config, logger *slog.Logger) (*ProviderRegistry, error) {
	// Create provider factory with config (manages API keys, creates providers)
	providerFactory := NewProviderFactory(cfg)

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
		logger.Info("provider available", "name", "anthropic", "models", "claude-*")
	} else {
		logger.Warn("ANTHROPIC_API_KEY not set - Anthropic provider not available")
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
	providerRegistry *ProviderRegistry,
	cfg *config.Config,
	txManager repositories.TransactionManager,
	capabilityRegistry *capabilities.Registry,
	authorizer services.ResourceAuthorizer,
	toolLimitResolver llmSvc.ToolLimitResolver,
	logger *slog.Logger,
) (*Services, *mstream.Registry, error) {
	// Create shared validator
	validator := NewThreadValidator(threadRepo)

	// Create mstream registry (for SSE streaming)
	streamRegistry := mstream.NewRegistry()

	// Start cleanup goroutine for old streams
	go streamRegistry.StartCleanup(context.Background())

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
	systemPromptResolver := streaming.NewSystemPromptResolver(
		projectRepo,
		threadRepo,
		documentRepo,
		logger,
	)

	// Create formatter registry and register doc tool formatters
	formatterRegistry := formatting.NewFormatterRegistry()
	formatterRegistry.Register("doc_search", &formatting.DocSearchFormatter{})
	formatterRegistry.Register("doc_view", &formatting.DocViewFormatter{})
	formatterRegistry.Register("doc_tree", formatting.NewDocTreeFormatter())
	formatterRegistry.Register("doc_edit", &formatting.DocEditFormatter{})

	// Create MessageBuilder service (pure conversion, no data loading)
	messageBuilder := threadhistory.NewMessageBuilderService(
		formatterRegistry,
		capabilityRegistry,
		logger,
	)

	// Create token estimator registry for interruption token estimation
	// Note: OpenRouter models use the Generation Stats API instead of token estimation
	tokenEstimatorRegistry := tokens.NewEstimatorRegistry()

	// Register Anthropic estimator if API key is available (uses token counting API)
	if cfg.AnthropicAPIKey != "" {
		anthropicEstimator, err := tokens.NewAnthropicEstimator(cfg.AnthropicAPIKey)
		if err != nil {
			logger.Warn("failed to create Anthropic token estimator",
				"error", err,
			)
		} else {
			tokenEstimatorRegistry.Register(anthropicEstimator)
			logger.Info("Anthropic token estimator registered")
		}
	}

	// Create TokenFinalizer that wraps the estimator registry
	// This centralizes token acquisition strategy (provider tokens -> OpenRouter API -> estimator)
	tokenFinalizer := tokens.NewDefaultTokenFinalizer(
		tokenEstimatorRegistry,
		cfg.OpenRouterAPIKey,
		logger,
	)

	logger.Info("token finalizer initialized")

	// Create streaming service (turn creation/orchestration)
	// Tools are created per-request with project-specific context
	// Uses minimal interfaces (ISP compliance)
	streamingService := streaming.NewService(
		turnRepo, // TurnWriter
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements all three)
		threadRepo,
		projectRepo, // For validating project access on cold start
		documentRepo,
		folderRepo,
		validator,
		responseGenerator,
		streamRegistry,
		cfg,
		txManager,
		systemPromptResolver,
		messageBuilder,
		toolLimitResolver,    // Tool round limit resolver (tier-ready)
		capabilityRegistry,   // For checking model capabilities (e.g., supports_tools)
		tokenFinalizer,       // For finalizing tokens on completion/interruption
		logger,
	)

	return &Services{
		Thread:        threadService,
		ThreadHistory: threadHistoryService,
		Streaming:     streamingService,
	}, streamRegistry, nil
}
