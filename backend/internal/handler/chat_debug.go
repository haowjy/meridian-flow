package handler

// chat_debug.go - Debug-only endpoints for testing assistant turn creation
// These handlers are always compiled but only registered when ENVIRONMENT=dev

import (
	"net/http"

	"meridian/internal/config"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/httputil"
)

// ChatDebugHandler provides debug-only endpoints for testing assistant turn creation
// WARNING: These endpoints are ONLY available when ENVIRONMENT=dev
// They bypass normal validation to allow manual testing of assistant responses
type ChatDebugHandler struct {
	conversationService llmSvc.ConversationService
	streamingService    llmSvc.StreamingService
	config              *config.Config
}

// NewChatDebugHandler creates a new debug chat handler
func NewChatDebugHandler(
	conversationService llmSvc.ConversationService,
	streamingService llmSvc.StreamingService,
	cfg *config.Config,
) *ChatDebugHandler {
	return &ChatDebugHandler{
		conversationService: conversationService,
		streamingService:    streamingService,
		config:              cfg,
	}
}

// CreateAssistantTurn creates an assistant turn (DEBUG ONLY)
// POST /debug/api/chats/{id}/turns
//
// WARNING: This endpoint bypasses validation and should NEVER be used in production.
// It exists solely for testing purposes during Phase 1 development.
//
// In Phase 2, assistant turns will be created automatically by the LLM response
// generator when users send messages.
//
// Request body:
//
//	{
//	  "prev_turn_id": "uuid",  // optional
//	  "role": "assistant",      // must be "assistant"
//	  "turn_blocks": [...]
//	}
func (h *ChatDebugHandler) CreateAssistantTurn(w http.ResponseWriter, r *http.Request) {
	// Get chat ID from route param
	chatID := r.PathValue("id")
	if chatID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Chat ID is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Parse request
	var req struct {
		PrevTurnID *string              `json:"prev_turn_id"`
		Role       string               `json:"role"`
		TurnBlocks []llmSvc.TurnBlockInput `json:"turn_blocks"`
	}
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate role is assistant
	if req.Role != "assistant" {
		httputil.RespondError(w, http.StatusBadRequest, "Debug endpoint only accepts role='assistant'")
		return
	}

	// Create assistant turn via debug service method
	model := h.config.DefaultModel
	if model == "" {
		model = "claude-haiku-4-5-20251001" // Fallback if config not set
	}
	turn, err := h.streamingService.CreateAssistantTurnDebug(r.Context(), chatID, userID, req.PrevTurnID, req.TurnBlocks, model)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, turn)
}

// BuildProviderRequest builds and returns the provider-facing JSON request that would be
// sent for a CreateTurn call (DEBUG ONLY).
//
// POST /debug/api/chats/{id}/llm-request
//
// This endpoint accepts the same payload as the production CreateTurn endpoint:
//
//	{
//	  "prev_turn_id": "uuid",         // optional
//	  "role": "user",                 // must be "user"
//	  "turn_blocks": [...],
//	  "request_params": { ... }       // model, max_tokens, tools, etc.
//	}
//
// It does NOT create any turns or call the provider. Instead, it returns the
// meridian-llm-go GenerateRequest (after all conversions) as JSON for inspection.
func (h *ChatDebugHandler) BuildProviderRequest(w http.ResponseWriter, r *http.Request) {
	// Get chat ID from route param
	chatID := r.PathValue("id")
	if chatID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Chat ID is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Parse request body into CreateTurnRequest shape
	var req llmSvc.CreateTurnRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Override chat/user IDs from context/path to avoid trusting client for these
	req.ChatID = chatID
	req.UserID = userID

	// Delegate to streaming service debug builder
	debugReq, err := h.streamingService.BuildDebugProviderRequest(r.Context(), &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, debugReq)
}

// GetChatTree retrieves the complete conversation tree structure (DEBUG ONLY)
// GET /debug/api/chats/{id}/tree
//
// WARNING: This endpoint is DEBUG ONLY and should NEVER be used in production.
// Production code should use the pagination endpoint (/api/chats/{id}/turns) which
// returns turns with nested blocks and sibling_ids for efficient branch discovery.
//
// This endpoint exists solely for debugging and visualizing the full conversation tree
// structure during development. It returns ALL turns in depth-first order with only
// IDs and parent relationships (no content).
//
// Response:
//
//	{
//	  "turns": [{"id": "...", "prev_turn_id": "..."}],
//	  "updated_at": "2024-01-01T00:00:00Z"
//	}
func (h *ChatDebugHandler) GetChatTree(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Get chat ID from route param
	chatID := r.PathValue("id")
	if chatID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Chat ID is required")
		return
	}

	// Call service
	tree, err := h.conversationService.GetChatTree(r.Context(), chatID, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, tree)
}
