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
	"meridian/internal/service/llm/chat"
	"meridian/internal/service/llm/conversation"
	"meridian/internal/service/llm/formatting"
	"meridian/internal/service/llm/streaming"
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
	Chat         llmSvc.ChatService
	Conversation llmSvc.ConversationService
	Streaming    llmSvc.StreamingService
}

// SetupServices initializes all LLM services with proper dependency injection
func SetupServices(
	chatRepo llmRepo.ChatRepository,
	turnRepo llmRepo.TurnRepository,
	projectRepo docsysRepo.ProjectRepository,
	documentRepo docsysRepo.DocumentRepository,
	folderRepo docsysRepo.FolderRepository,
	providerRegistry *ProviderRegistry,
	cfg *config.Config,
	txManager repositories.TransactionManager,
	capabilityRegistry *capabilities.Registry,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) (*Services, *mstream.Registry, error) {
	// Create shared validator
	validator := NewChatValidator(chatRepo)

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

	// Create chat service (CRUD only)
	chatService := chat.NewService(
		chatRepo,
		projectRepo,
		logger,
	)

	// Create conversation service (uses TurnReader + TurnNavigator for ISP compliance)
	conversationService := conversation.NewService(
		chatRepo,
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements both)
		capabilityRegistry,
		authorizer,
	)

	// Create system prompt resolver
	systemPromptResolver := streaming.NewSystemPromptResolver(
		projectRepo,
		chatRepo,
		documentRepo,
		logger,
	)

	// Create formatter registry and register doc tool formatters
	formatterRegistry := formatting.NewFormatterRegistry()
	formatterRegistry.Register("doc_search", &formatting.DocSearchFormatter{})
	formatterRegistry.Register("doc_view", &formatting.DocViewFormatter{})
	formatterRegistry.Register("doc_tree", formatting.NewDocTreeFormatter())

	// Create MessageBuilder service (pure conversion, no data loading)
	messageBuilder := conversation.NewMessageBuilderService(
		formatterRegistry,
		capabilityRegistry,
		logger,
	)

	// Create streaming service (turn creation/orchestration)
	// Tools are created per-request with project-specific context
	// Uses minimal interfaces (ISP compliance)
	streamingService := streaming.NewService(
		turnRepo, // TurnWriter
		turnRepo, // TurnReader
		turnRepo, // TurnNavigator (same repo implements all three)
		chatRepo,
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
		logger,
	)

	return &Services{
		Chat:         chatService,
		Conversation: conversationService,
		Streaming:    streamingService,
	}, streamRegistry, nil
}
