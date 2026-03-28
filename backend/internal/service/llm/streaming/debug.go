package streaming

// debug.go - Debug helpers for building provider-facing requests without execution.
// These helpers are used by debug HTTP endpoints (ENVIRONMENT=dev only) to inspect
// the exact payload that would be sent to the meridian-llm-go provider library.

import (
	"context"
	"encoding/json"
	"fmt"

	"meridian/internal/domain"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/adapters"
)

// BuildDebugProviderRequest builds the provider-facing request payload for a hypothetical
// CreateTurn request without creating any turns or contacting the provider.
//
// It mirrors the logic used by CreateTurn + startStreamingExecution:
//   - Validates the request
//   - Validates the thread exists
//   - Parses and normalizes request_params -> RequestParams struct
//   - Resolves the final model
//   - Loads the conversation path from prev_turn_id (if provided)
//   - Appends the hypothetical new user message from turn_blocks
//   - Converts the backend GenerateRequest -> library GenerateRequest
//   - Returns the library request as a generic JSON map for debug inspection
func (s *Service) BuildDebugProviderRequest(ctx context.Context, req *domainllm.CreateTurnRequest) (map[string]interface{}, error) {
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
	model := s.config.LLM.DefaultModel
	if model == "" {
		model = defaultFallbackModel // Fallback if config not set
	}
	if modelParam, ok := requestParams["model"].(string); ok && modelParam != "" {
		model = modelParam
	}

	// Validate and parse request params
	if err := domainllm.ValidateRequestParams(requestParams); err != nil {
		s.logger.Error("invalid request params for debug", "error", err)
		return nil, fmt.Errorf("invalid request params: %w", err)
	}

	params, err := domainllm.GetRequestParamStruct(requestParams)
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
		if mappedProvider, found := domainllm.GetProviderForModel(model); found {
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
	toolNames := resolveServerToolNames(s.config.LLM.SearchAPIKey != "", disabled)
	toolsParam, err := toolNamesToRequestParamsTools(toolNames)
	if err != nil {
		return nil, fmt.Errorf("failed to build tools for request params (debug): %w", err)
	}
	requestParams["tools"] = toolsParam

	// Load skills for tool metadata enrichment (mirrors CreateTurn).
	availableSkills := s.toolRegistryFactory.LoadAvailableSkills(ctx, thread.ProjectID)

	// Build tool registry to generate tool section for system prompt (OCP compliance)
	// Tools self-describe via metadata, registry generates the section dynamically
	// WithMutationStrategy is required — NewTextEditorTool panics if mutationStrategy is nil
	tempToolRegistry := s.toolRegistryFactory.BuildTempRegistry(
		ToolRegistryInputs{
			EnabledTools: enabledTools,
			ProjectID:    thread.ProjectID,
			UserID:       req.UserID,
			WorkItemSlug: "",
			Persona:      nil,
		},
		availableSkills,
	)

	// Get tool section from registry (OCP compliance - tools describe themselves)
	toolSection := tempToolRegistry.BuildSystemPromptSection()

	// Resolve system prompt from user, project, thread, and selected skills (mirror CreateTurn)
	// Always resolve if skills are selected, or if no user system prompt provided
	// Pass toolSection so the system prompt only mentions tools the LLM can actually use
	// Debug endpoint does not support persona/work context — pass nil for both
	if err := s.resolveSystemPromptForParams(ctx, *req.ThreadID, thread.ProjectID, req.UserID, params, req.SelectedSkills, toolSection, nil, nil); err != nil {
		s.logger.Error("failed to resolve system prompt for debug", "error", err)
		return nil, err
	}

	// Build conversation messages from prev_turn_id path (if provided).
	// Uses split helpers so the hypothetical user message is appended BEFORE
	// reference transformation — matching the production flow where the persisted
	// user turn is part of the path and its @-references get transformed.
	turnIDForPath := ""
	if req.PrevTurnID != nil {
		turnIDForPath = *req.PrevTurnID
	}

	messages, err := s.streamRequestBuilder.LoadConversationHistory(ctx, turnIDForPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load conversation history for debug: %w", err)
	}

	// Append hypothetical new user message from request turn_blocks
	if len(req.TurnBlocks) > 0 {
		blocks := make([]*domainllm.TurnBlock, len(req.TurnBlocks))
		for i, blockInput := range req.TurnBlocks {
			blocks[i] = &domainllm.TurnBlock{
				// ID, TurnID, CreatedAt are omitted for debug-only request
				BlockType:   blockInput.BlockType,
				Sequence:    i,
				TextContent: blockInput.TextContent,
				Content:     blockInput.Content,
			}
		}

		messages = append(messages, domainllm.Message{
			Role:    "user", // CreateTurn only allows user role from client
			Content: blocks,
		})
	}

	// Transform @-references AFTER appending the hypothetical message so its
	// references are expanded (mirrors production where the user turn is persisted
	// before the path is loaded and transformed).
	messages, err = s.streamRequestBuilder.TransformMessageReferences(ctx, messages, req.UserID, thread.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("failed to transform references for debug: %w", err)
	}

	// Build backend GenerateRequest that matches what we send to the provider
	generateReq := &domainllm.GenerateRequest{
		Messages: messages,
		Model:    model,
		Params:   params,
	}

	// Get provider (same registry used for real execution)
	llmProvider, err := s.streamRuntime.GetProvider(provider)
	if err != nil {
		return nil, fmt.Errorf("failed to get provider for debug: %w", err)
	}

	// If provider supports debug introspection, use it to build provider-level JSON
	type debugProvider interface {
		BuildDebugProviderRequest(ctx context.Context, req *domainllm.GenerateRequest) (map[string]interface{}, error)
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
