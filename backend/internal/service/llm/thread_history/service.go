package threadhistory

import (
	"context"
	"fmt"

	"meridian/internal/capabilities"
	authdomain "meridian/internal/domain/auth"
	domainllm "meridian/internal/domain/llm"
)

// Service implements the ThreadHistoryService interface
// Handles thread history and navigation operations
// Uses minimal interfaces (TurnReader, TurnNavigator) for better ISP compliance
type Service struct {
	threadRepo         domainllm.ThreadStore
	turnReader         domainllm.TurnReader
	turnNavigator      domainllm.TurnNavigator
	capabilityRegistry *capabilities.Registry
	authorizer         authdomain.ResourceAuthorizer
}

// NewService creates a new thread history service
func NewService(
	threadRepo domainllm.ThreadStore,
	turnReader domainllm.TurnReader,
	turnNavigator domainllm.TurnNavigator,
	capabilityRegistry *capabilities.Registry,
	authorizer authdomain.ResourceAuthorizer,
) domainllm.ThreadHistoryService {
	return &Service{
		threadRepo:         threadRepo,
		turnReader:         turnReader,
		turnNavigator:      turnNavigator,
		capabilityRegistry: capabilityRegistry,
		authorizer:         authorizer,
	}
}

// GetTurnPath retrieves the turn path from a turn to root
// Authorization is checked first via the injected authorizer
func (s *Service) GetTurnPath(ctx context.Context, userID, turnID string) ([]domainllm.Turn, error) {
	// Authorize: check user can access this turn
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID); err != nil {
		return nil, err
	}

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
				turns[i].Blocks = []domainllm.TurnBlock{}
			}
		}
	}

	return turns, nil
}

// GetTurnSiblings retrieves all sibling turns (including self) with blocks
// Authorization is checked first via the injected authorizer
func (s *Service) GetTurnSiblings(ctx context.Context, userID, turnID string) ([]domainllm.Turn, error) {
	// Authorize: check user can access this turn
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID); err != nil {
		return nil, err
	}

	return s.turnNavigator.GetTurnSiblings(ctx, turnID)
}

// GetThreadTree retrieves the lightweight tree structure for cache validation
func (s *Service) GetThreadTree(ctx context.Context, threadID, userID string) (*domainllm.ThreadTree, error) {
	tree, err := s.threadRepo.GetThreadTree(ctx, threadID, userID)
	if err != nil {
		return nil, err
	}

	return tree, nil
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
func (s *Service) GetPaginatedTurns(ctx context.Context, threadID, userID string, fromTurnID *string, limit int, direction string, updateLastViewed bool) (*domainllm.PaginatedTurnsResponse, error) {
	// Delegate to repository (validation happens there)
	response, err := s.turnNavigator.GetPaginatedTurns(ctx, threadID, userID, fromTurnID, limit, direction, updateLastViewed)
	if err != nil {
		return nil, err
	}

	return response, nil
}

// GetTurnWithBlocks retrieves a turn's metadata and all its content blocks
// Authorization is checked first via the injected authorizer
func (s *Service) GetTurnWithBlocks(ctx context.Context, userID, turnID string) (*domainllm.Turn, error) {
	// Authorize: check user can access this turn
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID); err != nil {
		return nil, err
	}

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
// Authorization is checked first via the injected authorizer
func (s *Service) GetTurnTokenUsage(ctx context.Context, userID, turnID string) (*domainllm.TokenUsageInfo, error) {
	// Authorize: check user can access this turn
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID); err != nil {
		return nil, err
	}

	// Get turn metadata
	turn, err := s.turnReader.GetTurn(ctx, turnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get turn: %w", err)
	}

	// Initialize response
	info := &domainllm.TokenUsageInfo{
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
	modelCap, err := s.capabilityRegistry.GetModelCapabilities(provider, *turn.Model)
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
