package streaming

// debug.go - Debug helpers for building provider-facing requests without execution.
// These helpers are used by debug HTTP endpoints (ENVIRONMENT=dev only) to inspect
// the exact payload that would be sent to the meridian-llm-go provider library.

import (
	"context"
	"encoding/json"
	"fmt"

	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/adapters"
)

// BuildDebugProviderRequest builds the provider-facing request payload for a hypothetical
// CreateTurn request without creating any turns or contacting the provider.
//
// It mirrors the logic used by CreateTurn + startStreamingExecution:
//   - Validates the request
//   - Validates the chat exists
//   - Parses and normalizes request_params → RequestParams struct
//   - Resolves the final model
//   - Loads the conversation path from prev_turn_id (if provided)
//   - Appends the hypothetical new user message from turn_blocks
//   - Converts the backend GenerateRequest → library GenerateRequest
//   - Returns the library request as a generic JSON map for debug inspection
func (s *Service) BuildDebugProviderRequest(ctx context.Context, req *llmSvc.CreateTurnRequest) (map[string]interface{}, error) {
	// Normalize empty string to nil for prev_turn_id (matches CreateTurn)
	if req.PrevTurnID != nil && *req.PrevTurnID == "" {
		req.PrevTurnID = nil
	}

	// Validate request shape (role, blocks, etc.)
	if err := s.validateCreateTurnRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Validate chat exists and is not deleted
	if err := s.validator.ValidateChat(ctx, req.ChatID, req.UserID); err != nil {
		return nil, err
	}

	// Prepare request params and model (mirror CreateTurn)
	requestParams := req.RequestParams
	if requestParams == nil {
		requestParams = make(map[string]interface{})
	}

	// Extract model from request_params with default fallback from config
	model := s.config.DefaultModel
	if model == "" {
		model = "claude-haiku-4-5-20251001" // Fallback if config not set
	}
	if modelParam, ok := requestParams["model"].(string); ok && modelParam != "" {
		model = modelParam
	}

	// Validate and parse request params
	if err := llmModels.ValidateRequestParams(requestParams); err != nil {
		s.logger.Error("invalid request params for debug", "error", err)
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	params, err := llmModels.GetRequestParamStruct(requestParams)
	if err != nil {
		s.logger.Error("failed to parse request params for debug", "error", err)
		return nil, fmt.Errorf("failed to parse request params: %w", err)
	}

	// Allow model override via params
	if params.Model != nil && *params.Model != "" {
		model = *params.Model
	}

	// Extract provider from request_params or infer from model
	var provider string
	if params.Provider != nil && *params.Provider != "" {
		// Provider explicitly specified
		provider = *params.Provider
	} else {
		// Try to infer provider from model name
		if mappedProvider, found := llmModels.GetProviderForModel(model); found {
			provider = mappedProvider
		} else {
			// No mapping found - default to openrouter (has all models)
			provider = "openrouter"
		}
	}

	// Resolve system prompt from user, project, chat, and selected skills (mirror CreateTurn)
	// Always resolve if skills are selected, or if no user system prompt provided
	if err := s.resolveSystemPromptForParams(ctx, req.ChatID, req.UserID, params, req.SelectedSkills); err != nil {
		s.logger.Error("failed to resolve system prompt for debug", "error", err)
		return nil, err
	}

	// Build conversation path from prev_turn_id (if provided)
	var path []llmModels.Turn
	if req.PrevTurnID != nil {
		path, err = s.turnRepo.GetTurnPath(ctx, *req.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("failed to get turn path for debug: %w", err)
		}

		// Load content blocks for all turns in the path (matches startStreamingExecution)
		for i := range path {
			blocks, err := s.turnRepo.GetTurnBlocks(ctx, path[i].ID)
			if err != nil {
				return nil, fmt.Errorf("failed to get content blocks for debug: %w", err)
			}
			path[i].Blocks = blocks
		}
	}

	// Build messages from turn history
	messages, err := s.buildMessagesFromPath(path)
	if err != nil {
		return nil, fmt.Errorf("failed to build messages for debug: %w", err)
	}

	// Append hypothetical new user message from request turn_blocks
	if len(req.TurnBlocks) > 0 {
		blocks := make([]*llmModels.TurnBlock, len(req.TurnBlocks))
		for i, blockInput := range req.TurnBlocks {
			blocks[i] = &llmModels.TurnBlock{
				// ID, TurnID, CreatedAt are omitted for debug-only request
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content,
			}
		}

		messages = append(messages, llmSvc.Message{
			Role:    "user", // CreateTurn only allows user role from client
			Content: blocks,
		})
	}

	// Build backend GenerateRequest that matches what we send to the provider
	generateReq := &llmSvc.GenerateRequest{
		Messages: messages,
		Model:    model,
		Params:   params,
	}

	// Get provider (same registry used for real execution)
	llmProvider, err := s.providerGetter.GetProvider(provider)
	if err != nil {
		return nil, fmt.Errorf("failed to get provider for debug: %w", err)
	}

	// If provider supports debug introspection, use it to build provider-level JSON
	type debugProvider interface {
		BuildDebugProviderRequest(ctx context.Context, req *llmSvc.GenerateRequest) (map[string]interface{}, error)
	}

	if dbg, ok := llmProvider.(debugProvider); ok {
		return dbg.BuildDebugProviderRequest(ctx, generateReq)
	}

	// Fallback: return the library-level GenerateRequest JSON (previous behavior)
	libReq, err := adapters.ConvertToLibraryRequest(generateReq)
	if err != nil {
		return nil, fmt.Errorf("failed to convert to library request for debug: %w", err)
	}

	jsonBytes, err := json.Marshal(libReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal library request for debug: %w", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(jsonBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal library request for debug: %w", err)
	}

	return result, nil
}
