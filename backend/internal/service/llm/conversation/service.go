package conversation

import (
	"context"
	"fmt"

	llmprovider "github.com/haowjy/meridian-llm-go"

	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
)

// Service implements the ConversationService interface
// Handles conversation history and navigation operations
// Uses minimal interfaces (TurnReader, TurnNavigator) for better ISP compliance
type Service struct {
	chatRepo      llmRepo.ChatRepository
	turnReader    llmRepo.TurnReader
	turnNavigator llmRepo.TurnNavigator
}

// NewService creates a new conversation service
func NewService(
	chatRepo llmRepo.ChatRepository,
	turnReader llmRepo.TurnReader,
	turnNavigator llmRepo.TurnNavigator,
) llmSvc.ConversationService {
	return &Service{
		chatRepo:      chatRepo,
		turnReader:    turnReader,
		turnNavigator: turnNavigator,
	}
}

// GetTurnPath retrieves the conversation path from a turn to root
func (s *Service) GetTurnPath(ctx context.Context, turnID string) ([]llmModels.Turn, error) {
	turns, err := s.turnNavigator.GetTurnPath(ctx, turnID)
	if err != nil {
		return nil, err
	}

	// Batch load content blocks for all turns (eliminates N+1 query)
	if len(turns) > 0 {
		// Extract turn IDs
		turnIDs := make([]string, len(turns))
		for i, turn := range turns {
			turnIDs[i] = turn.ID
		}

		// Load blocks for all turns in a single query
		blocksByTurn, err := s.turnReader.GetTurnBlocksForTurns(ctx, turnIDs)
		if err != nil {
			return nil, err
		}

		// Attach blocks to their respective turns
		for i := range turns {
			if blocks, ok := blocksByTurn[turns[i].ID]; ok {
				turns[i].Blocks = blocks
			} else {
				// No blocks found for this turn, set empty slice
				turns[i].Blocks = []llmModels.TurnBlock{}
			}
		}
	}

	return turns, nil
}

// GetTurnSiblings retrieves all sibling turns (including self) with blocks
func (s *Service) GetTurnSiblings(ctx context.Context, turnID string) ([]llmModels.Turn, error) {
	return s.turnNavigator.GetTurnSiblings(ctx, turnID)
}

// GetChatTree retrieves the lightweight tree structure for cache validation
func (s *Service) GetChatTree(ctx context.Context, chatID, userID string) (*llmModels.ChatTree, error) {
	tree, err := s.chatRepo.GetChatTree(ctx, chatID, userID)
	if err != nil {
		return nil, err
	}

	return tree, nil
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
func (s *Service) GetPaginatedTurns(ctx context.Context, chatID, userID string, fromTurnID *string, limit int, direction string, updateLastViewed bool) (*llmModels.PaginatedTurnsResponse, error) {
	// Delegate to repository (validation happens there)
	response, err := s.turnNavigator.GetPaginatedTurns(ctx, chatID, userID, fromTurnID, limit, direction, updateLastViewed)
	if err != nil {
		return nil, err
	}

	return response, nil
}

// GetTurnWithBlocks retrieves a turn's metadata and all its content blocks
func (s *Service) GetTurnWithBlocks(ctx context.Context, turnID string) (*llmModels.Turn, error) {
	// Get turn metadata (status, error, etc.)
	turn, err := s.turnReader.GetTurn(ctx, turnID)
	if err != nil {
		return nil, err
	}

	// Get blocks for this turn
	blocks, err := s.turnReader.GetTurnBlocks(ctx, turnID)
	if err != nil {
		return nil, err
	}

	// Attach blocks to turn
	turn.Blocks = blocks

	return turn, nil
}

// GetTurnTokenUsage retrieves token usage statistics for a turn
func (s *Service) GetTurnTokenUsage(ctx context.Context, turnID string) (*llmModels.TokenUsageInfo, error) {
	// Get turn metadata
	turn, err := s.turnReader.GetTurn(ctx, turnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get turn: %w", err)
	}

	// Initialize response
	info := &llmModels.TokenUsageInfo{
		TurnID:       turnID,
		InputTokens:  turn.InputTokens,
		OutputTokens: turn.OutputTokens,
		Model:        turn.Model,
	}

	// Calculate total tokens if both are available
	if turn.InputTokens != nil && turn.OutputTokens != nil {
		total := *turn.InputTokens + *turn.OutputTokens
		info.TotalTokens = &total
	}

	// If no model specified, return what we have
	if turn.Model == nil || *turn.Model == "" {
		return info, nil
	}

	// Determine provider from request params or infer from model
	provider := "anthropic" // default
	if turn.RequestParams != nil {
		if providerParam, ok := turn.RequestParams["provider"].(string); ok && providerParam != "" {
			provider = providerParam
		}
	}
	info.ProviderName = &provider

	// Get model capability from registry
	registry := llmprovider.GetCapabilityRegistry()
	modelCap, err := registry.GetModelCapability(provider, *turn.Model)
	if err != nil {
		// Model not in registry - return what we have without limit/percentage
		return info, nil
	}

	// Set context limit
	contextLimit := modelCap.ContextWindow
	info.ContextLimit = &contextLimit

	// Calculate usage percentage if we have total tokens
	if info.TotalTokens != nil && contextLimit > 0 {
		percent := (float64(*info.TotalTokens) / float64(contextLimit)) * 100
		info.UsagePercent = &percent

		// Generate warning message if usage is high
		if percent >= 75 {
			var warningMsg string
			if percent >= 90 {
				warningMsg = fmt.Sprintf("Critical: Using %.1f%% of context limit (%d/%d tokens). Consider wrapping up.", percent, *info.TotalTokens, contextLimit)
			} else {
				warningMsg = fmt.Sprintf("Warning: Using %.1f%% of context limit (%d/%d tokens). Approaching limit.", percent, *info.TotalTokens, contextLimit)
			}
			info.WarningMessage = &warningMsg
		}
	}

	return info, nil
}
