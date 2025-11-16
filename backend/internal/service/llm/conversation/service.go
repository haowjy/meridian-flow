package conversation

import (
	"context"

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
func (s *Service) GetPaginatedTurns(ctx context.Context, chatID, userID string, fromTurnID *string, limit int, direction string) (*llmModels.PaginatedTurnsResponse, error) {
	// Delegate to repository (validation happens there)
	response, err := s.turnNavigator.GetPaginatedTurns(ctx, chatID, userID, fromTurnID, limit, direction)
	if err != nil {
		return nil, err
	}

	return response, nil
}
