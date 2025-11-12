package llm

import (
	"context"
	"fmt"
	"log/slog"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/adapters"
	"meridian/internal/service/llm/chat"
	"meridian/internal/service/llm/conversation"
	"meridian/internal/service/llm/streaming"
)

// SetupProviders initializes and registers all configured LLM providers.
// Returns a configured ProviderRegistry or an error if setup fails.
func SetupProviders(cfg *config.Config, logger *slog.Logger) (*ProviderRegistry, error) {
	registry := NewProviderRegistry()

	// Register Anthropic provider (if API key is configured)
	if cfg.AnthropicAPIKey != "" {
		anthropicAdapter, err := adapters.NewAnthropicAdapter(cfg.AnthropicAPIKey)
		if err != nil {
			return nil, fmt.Errorf("failed to create Anthropic adapter: %w", err)
		}
		registry.RegisterProvider(anthropicAdapter)
		logger.Info("provider registered", "name", "anthropic", "models", "claude-*")
	} else {
		logger.Warn("ANTHROPIC_API_KEY not set - Anthropic provider not available")
	}

	// Register Lorem provider (mock - dev/test only)
	if cfg.Environment == "dev" || cfg.Environment == "test" {
		loremAdapter := adapters.NewLoremAdapter()
		registry.RegisterProvider(loremAdapter)
		logger.Warn("provider registered (MOCK)",
			"name", "lorem",
			"models", "lorem-*",
			"warning", "Lorem provider is for testing only - not for production!")
	}

	// Future providers: OpenAI, Google, OpenRouter, etc.
	// if cfg.OpenAIAPIKey != "" { ... }

	// Validate registry has at least one provider
	if err := registry.Validate(); err != nil {
		return nil, fmt.Errorf("provider registry validation failed: %w", err)
	}

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
	providerRegistry *ProviderRegistry,
	cfg *config.Config,
	txManager repositories.TransactionManager,
	logger *slog.Logger,
) (*Services, *mstream.Registry, error) {
	// Create shared validator
	validator := NewChatValidator(chatRepo)

	// Create mstream registry (for SSE streaming)
	streamRegistry := mstream.NewRegistry()

	// Start cleanup goroutine for old streams
	go streamRegistry.StartCleanup(context.Background())

	// Create response generator
	responseGenerator := streaming.NewResponseGenerator(providerRegistry, turnRepo, logger)

	// Create chat service (CRUD only)
	chatService := chat.NewService(
		chatRepo,
		projectRepo,
		logger,
	)

	// Create conversation service (history/navigation)
	conversationService := conversation.NewService(
		chatRepo,
		turnRepo,
	)

	// Create streaming service (turn creation/orchestration)
	streamingService := streaming.NewService(
		turnRepo,
		validator,
		responseGenerator,
		streamRegistry,
		cfg,
		txManager,
		logger,
	)

	return &Services{
		Chat:         chatService,
		Conversation: conversationService,
		Streaming:    streamingService,
	}, streamRegistry, nil
}
