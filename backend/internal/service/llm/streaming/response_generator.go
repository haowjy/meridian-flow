package streaming

import (
	"context"
	"fmt"
	"log/slog"

	domainllm "meridian/internal/domain/services/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/domain/models/llm"
)

// ProviderRegistry is the interface for getting LLM providers
// This avoids import cycles with the parent llm package
type ProviderRegistry interface {
	GetProvider(model string) (domainllm.LLMProvider, error)
}

// ResponseGenerator handles LLM response generation
type ResponseGenerator struct {
	registry ProviderRegistry
	turnRepo llmRepo.TurnRepository
	logger   *slog.Logger
}

// NewResponseGenerator creates a new response generator
func NewResponseGenerator(registry ProviderRegistry, turnRepo llmRepo.TurnRepository, logger *slog.Logger) *ResponseGenerator {
	return &ResponseGenerator{
		registry: registry,
		turnRepo: turnRepo,
		logger:   logger,
	}
}

// GenerateResponse generates an LLM response for a user turn.
// This is a synchronous implementation - it blocks until the response is complete.
// Streaming support will be added in a future phase.
func (g *ResponseGenerator) GenerateResponse(ctx context.Context, userTurnID string, model string, requestParams map[string]interface{}) (*domainllm.GenerateResponse, error) {
	// Validate request params
	if err := llm.ValidateRequestParams(requestParams); err != nil {
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	// Parse request params to typed struct
	params, err := llm.GetRequestParamStruct(requestParams)
	if err != nil {
		return nil, fmt.Errorf("failed to parse request params: %w", err)
	}

	// Allow model override via params
	if params.Model != nil && *params.Model != "" {
		model = *params.Model
	}

	g.logger.Info("generating LLM response",
		"user_turn_id", userTurnID,
		"model", model,
	)

	// 1. Get conversation path (turn history)
	path, err := g.turnRepo.GetTurnPath(ctx, userTurnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get turn path: %w", err)
	}

	if len(path) == 0 {
		return nil, fmt.Errorf("turn path is empty")
	}

	g.logger.Debug("retrieved turn path",
		"turn_count", len(path),
	)

	// 1b. Load content blocks for all turns in the path
	for i := range path {
		blocks, err := g.turnRepo.GetTurnBlocks(ctx, path[i].ID)
		if err != nil {
			return nil, fmt.Errorf("failed to get content blocks for turn %s: %w", path[i].ID, err)
		}
		path[i].Blocks = blocks
	}

	g.logger.Debug("loaded content blocks for turns")

	// 2. Build messages from turn history
	messages, err := g.buildMessages(path)
	if err != nil {
		return nil, fmt.Errorf("failed to build messages: %w", err)
	}

	g.logger.Debug("built message context",
		"message_count", len(messages),
	)

	// 3. Get provider for model
	provider, err := g.registry.GetProvider(model)
	if err != nil {
		return nil, fmt.Errorf("failed to get provider: %w", err)
	}

	// 4. Generate response with params
	req := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    model,
		Params:   params,
	}

	response, err := provider.GenerateResponse(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("provider failed to generate response: %w", err)
	}

	g.logger.Info("LLM response generated",
		"model", response.Model,
		"input_tokens", response.InputTokens,
		"output_tokens", response.OutputTokens,
		"turn_blocks", len(response.Content),
		"stop_reason", response.StopReason,
	)

	return response, nil
}

// buildMessages converts turn history to LLM messages.
// path is ordered from oldest to newest (root → current turn)
func (g *ResponseGenerator) buildMessages(path []llm.Turn) ([]domainllm.Message, error) {
	messages := make([]domainllm.Message, 0, len(path))

	for _, turn := range path {
		// Determine role
		var role string
		switch turn.Role {
		case "user":
			role = "user"
		case "assistant":
			role = "assistant"
		default:
			return nil, fmt.Errorf("unsupported turn role: %s", turn.Role)
		}

		// Get content blocks for this turn
		if len(turn.Blocks) == 0 {
			// Empty turn - skip it
			g.logger.Warn("skipping turn with no content blocks", "turn_id", turn.ID)
			continue
		}

		// Convert []TurnBlock to []*TurnBlock
		contentPtrs := make([]*llm.TurnBlock, len(turn.Blocks))
		for i := range turn.Blocks {
			contentPtrs[i] = &turn.Blocks[i]
		}

		messages = append(messages, domainllm.Message{
			Role:    role,
			Content: contentPtrs,
		})
	}

	return messages, nil
}
