package handler

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/domain/services"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/handler/sse"
	"meridian/internal/httputil"
)

// ChatHandler handles chat HTTP requests
// Follows Clean Architecture: handlers only communicate with services, never repositories
type ChatHandler struct {
	chatService         llmSvc.ChatService
	conversationService llmSvc.ConversationService
	streamingService    llmSvc.StreamingService
	registry            *mstream.Registry
	authorizer          services.ResourceAuthorizer
	logger              *slog.Logger
}

// NewChatHandler creates a new chat handler
func NewChatHandler(
	chatService llmSvc.ChatService,
	conversationService llmSvc.ConversationService,
	streamingService llmSvc.StreamingService,
	registry *mstream.Registry,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) *ChatHandler {
	return &ChatHandler{
		chatService:         chatService,
		conversationService: conversationService,
		streamingService:    streamingService,
		registry:            registry,
		authorizer:          authorizer,
		logger:              logger,
	}
}

// CreateChat creates a new chat session
// POST /api/chats
// Returns 201 if created, 409 with existing chat if duplicate
func (h *ChatHandler) CreateChat(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Parse request
	var req llmSvc.CreateChatRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service
	chat, err := h.chatService.CreateChat(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, func(id string) (*llmModels.Chat, error) {
			return h.chatService.GetChat(r.Context(), id, userID)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, chat)
}

// ListChats retrieves all chats for a project
// GET /api/chats?project_id=:id
func (h *ChatHandler) ListChats(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Get project ID from query param
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Call service
	chats, err := h.chatService.ListChats(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, chats)
}

// GetChat retrieves a single chat by ID
// GET /api/chats/{id}
func (h *ChatHandler) GetChat(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	chat, err := h.chatService.GetChat(r.Context(), chatID, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, chat)
}

// UpdateChat updates a chat's title
// PATCH /api/chats/{id}
func (h *ChatHandler) UpdateChat(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req llmSvc.UpdateChatRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Call service
	chat, err := h.chatService.UpdateChat(r.Context(), chatID, userID, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, chat)
}

// UpdateLastViewedTurn updates the last_viewed_turn_id for a chat
// PATCH /api/chats/{id}/last-viewed-turn
func (h *ChatHandler) UpdateLastViewedTurn(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req struct {
		TurnID string `json:"turn_id"`
	}
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Call service (all validation handled by service layer)
	if err := h.chatService.UpdateLastViewedTurn(r.Context(), chatID, userID, req.TurnID); err != nil {
		handleError(w, err)
		return
	}

	// Return success with no body (204 No Content)
	w.WriteHeader(http.StatusNoContent)
}

// DeleteChat soft-deletes a chat
// DELETE /api/chats/{id}
func (h *ChatHandler) DeleteChat(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	deletedChat, err := h.chatService.DeleteChat(r.Context(), chatID, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, deletedChat)
}

// CreateTurn creates a new turn (user message)
// POST /api/chats/{id}/turns
func (h *ChatHandler) CreateTurn(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req llmSvc.CreateTurnRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ChatID = chatID
	req.UserID = userID

	// Call service
	response, err := h.streamingService.CreateTurn(r.Context(), &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, response)
}

// GetTurnPath retrieves the conversation path from a turn to root
// GET /api/turns/{id}/path
func (h *ChatHandler) GetTurnPath(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	turns, err := h.conversationService.GetTurnPath(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, turns)
}

// GetTurnSiblings retrieves all sibling turns (including self) for version browsing
// GET /api/turns/{id}/siblings
func (h *ChatHandler) GetTurnSiblings(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	siblings, err := h.conversationService.GetTurnSiblings(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, siblings)
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
// GET /api/chats/{id}/turns?from_turn_id=X&limit=100&direction=both
func (h *ChatHandler) GetPaginatedTurns(w http.ResponseWriter, r *http.Request) {
	chatID, ok := PathParam(w, r, "id", "Chat ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Parse query parameters
	fromTurnIDStr := r.URL.Query().Get("from_turn_id")
	var fromTurnID *string
	if fromTurnIDStr != "" {
		fromTurnID = &fromTurnIDStr
	}

	// Parse update_last_viewed (default: false)
	updateLastViewed := false
	if ulv := r.URL.Query().Get("update_last_viewed"); ulv != "" {
		parsed, err := strconv.ParseBool(ulv)
		if err == nil {
			updateLastViewed = parsed
		}
	}

	// Parse limit and direction
	limit := QueryInt(r, "limit", 100, 1, math.MaxInt)
	direction := r.URL.Query().Get("direction")

	// Call service
	response, err := h.conversationService.GetPaginatedTurns(r.Context(), chatID, userID, fromTurnID, limit, direction, updateLastViewed)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, response)
}

// GetTurnBlocksResponse is the response for GET /api/turns/{id}/blocks
type GetTurnBlocksResponse struct {
	TurnID string                `json:"turn_id"`
	Status string                `json:"status"`
	Error  *string               `json:"error,omitempty"`
	Blocks []llmModels.TurnBlock `json:"blocks"`
}

// GetTurnBlocks retrieves all completed turn blocks for a turn
// GET /api/turns/{id}/blocks
// Used for reconnection - client fetches completed blocks before connecting to SSE stream
func (h *ChatHandler) GetTurnBlocks(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid turn ID format")
		return
	}

	userID := httputil.GetUserID(r)

	// Get turn with blocks from service (follows Clean Architecture)
	turn, err := h.conversationService.GetTurnWithBlocks(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	// Return structured response with turn status and error
	response := GetTurnBlocksResponse{
		TurnID: turn.ID,
		Status: turn.Status,
		Error:  turn.Error,
		Blocks: turn.Blocks,
	}

	httputil.RespondJSON(w, http.StatusOK, response)
}

// GetTurnTokenUsage retrieves token usage statistics for a turn
// GET /api/turns/{id}/token-usage
func (h *ChatHandler) GetTurnTokenUsage(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid turn ID format")
		return
	}

	userID := httputil.GetUserID(r)

	// Get token usage from service
	tokenUsage, err := h.conversationService.GetTurnTokenUsage(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, tokenUsage)
}

// InterruptTurn cancels a streaming turn
// POST /api/turns/{id}/interrupt
func (h *ChatHandler) InterruptTurn(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid turn ID format")
		return
	}

	userID := httputil.GetUserID(r)

	// Authorize: check user can access this turn
	if err := h.authorizer.CanAccessTurn(r.Context(), userID, turnID); err != nil {
		handleError(w, err)
		return
	}

	// Get stream from registry
	stream := h.registry.Get(turnID)
	if stream == nil {
		httputil.RespondError(w, http.StatusNotFound, "Turn is not currently streaming")
		return
	}

	// Cancel the stream (executor will update turn status in database)
	stream.Cancel()

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"turn_id": turnID,
		"status":  "cancelled",
	})
}

// StreamTurn streams turn deltas via Server-Sent Events (SSE)
// GET /api/turns/{id}/stream
func (h *ChatHandler) StreamTurn(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Authorize: check user can access this turn
	if err := h.authorizer.CanAccessTurn(r.Context(), userID, turnID); err != nil {
		handleError(w, err)
		return
	}

	// Note: SSE config is created here with defaults
	// TODO: Consider injecting SSE config at ChatHandler creation time for better testability
	sseConfig := sse.DefaultConfig()
	NewSSEHandler(h.registry, h.logger, sseConfig).StreamTurn(w, r)
}
