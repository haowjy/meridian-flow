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
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tools"
)

// BuildDebugProviderRequest builds the provider-facing request payload for a hypothetical
// CreateTurn request without creating any turns or contacting the provider.
//
// It mirrors the logic used by CreateTurn + startStreamingExecution:
//   - Validates the request
//   - Validates the thread exists
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

	// Debug endpoint requires thread_id (comes from path param)
	if req.ThreadID == nil {
		return nil, fmt.Errorf("%w: thread_id is required for debug endpoint", domain.ErrValidation)
	}

	// Validate thread exists and is not deleted
	if err := s.validator.ValidateThread(ctx, *req.ThreadID, req.UserID); err != nil {
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

	// Extract enabled tools from requestParams for tool registration
	enabledTools := extractToolNames(requestParams)

	// Get thread to get project_id for tool registry
	thread, err := s.threadRepo.GetThread(ctx, *req.ThreadID, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to get thread for debug: %w", err)
	}

	// Mirror production tool policy: server decides which tools are available.
	project, err := s.projectRepo.GetByID(ctx, thread.ProjectID, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("failed to load project for tool policy (debug): %w", err)
	}
	disabled := parseDisabledTools(project.Preferences)
	toolNames := resolveServerToolNames(s.config.SearchAPIKey != "", disabled)
	toolsParam, err := toolNamesToRequestParamsTools(toolNames)
	if err != nil {
		return nil, fmt.Errorf("failed to build tools for request params (debug): %w", err)
	}
	requestParams["tools"] = toolsParam

	// Load skills for tool metadata enrichment (mirrors CreateTurn)
	availableSkills, err := s.skillService.ListSkills(ctx, req.UserID, thread.ProjectID)
	if err != nil {
		s.logger.Warn("failed to load skills for tool metadata (debug)", "error", err)
		availableSkills = nil
	}

	// Build tool registry to generate tool section for system prompt (OCP compliance)
	// Tools self-describe via metadata, registry generates the section dynamically
	tempToolRegistry := tools.NewToolRegistryBuilder().
		WithNamespaceService(s.namespaceSvc).
		WithEnabledDocumentTools(enabledTools, thread.ProjectID, req.UserID, s.documentSvc, s.folderSvc).
		WithEnabledSkillTools(enabledTools, thread.ProjectID, req.UserID, s.skillService, false, availableSkills).
		Build()

	// Get tool section from registry (OCP compliance - tools describe themselves)
	toolSection := tempToolRegistry.BuildSystemPromptSection()

	// Resolve system prompt from user, project, thread, and selected skills (mirror CreateTurn)
	// Always resolve if skills are selected, or if no user system prompt provided
	// Pass toolSection so the system prompt only mentions tools the LLM can actually use
	if err := s.resolveSystemPromptForParams(ctx, *req.ThreadID, thread.ProjectID, req.UserID, params, req.SelectedSkills, toolSection); err != nil {
		s.logger.Error("failed to resolve system prompt for debug", "error", err)
		return nil, err
	}

	// Build conversation path from prev_turn_id (if provided)
	var path []llmModels.Turn
	if req.PrevTurnID != nil {
		path, err = s.turnNavigator.GetTurnPath(ctx, *req.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("failed to get turn path for debug: %w", err)
		}

		// Load content blocks for all turns in the path (matches startStreamingExecution)
		for i := range path {
			blocks, err := s.turnReader.GetTurnBlocks(ctx, path[i].ID)
			if err != nil {
				return nil, fmt.Errorf("failed to get content blocks for debug: %w", err)
			}
			path[i].Blocks = blocks
		}
	}

	// Build messages from turn history using MessageBuilder
	messages, err := s.messageBuilder.BuildMessages(ctx, path)
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

	// Post-process: compile @-references into synthetic tool_use/tool_result pairs
	// (matches startStreamingExecution behavior for debug inspection)
	refTransformer := threadhistory.NewReferenceMessageTransformer(
		s.documentSvc, s.folderSvc, s.formatterRegistry, req.UserID, thread.ProjectID, s.logger,
	)
	messages, err = refTransformer.TransformMessages(ctx, messages)
	if err != nil {
		return nil, fmt.Errorf("failed to transform references for debug: %w", err)
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
