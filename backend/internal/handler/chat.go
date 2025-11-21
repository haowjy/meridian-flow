package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/httputil"
)

// ChatHandler handles chat HTTP requests
// Follows Clean Architecture: handlers only communicate with services, never repositories
type ChatHandler struct {
	chatService         llmSvc.ChatService
	conversationService llmSvc.ConversationService
	streamingService    llmSvc.StreamingService
	registry            *mstream.Registry
	logger              *slog.Logger
}

// NewChatHandler creates a new chat handler
func NewChatHandler(
	chatService llmSvc.ChatService,
	conversationService llmSvc.ConversationService,
	streamingService llmSvc.StreamingService,
	registry *mstream.Registry,
	logger *slog.Logger,
) *ChatHandler {
	return &ChatHandler{
		chatService:         chatService,
		conversationService: conversationService,
		streamingService:    streamingService,
		registry:            registry,
		logger:              logger,
	}
}

// CreateChat creates a new chat session
// POST /api/chats
// Returns 201 if created, 409 with existing chat if duplicate
func (h *ChatHandler) CreateChat(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

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
		// Handle conflict by fetching and returning existing chat with 409
		HandleCreateConflict(w, err, func() (*llmModels.Chat, error) {
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.chatService.GetChat(r.Context(), conflictErr.ResourceID, userID)
			}
			return nil, err
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, chat)
}

// ListChats retrieves all chats for a project
// GET /api/chats?project_id=:id
func (h *ChatHandler) ListChats(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

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

	// Parse request
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

// DeleteChat soft-deletes a chat
// DELETE /api/chats/{id}
func (h *ChatHandler) DeleteChat(w http.ResponseWriter, r *http.Request) {
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
	// Get chat ID from route param
	chatID := r.PathValue("id")
	if chatID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Chat ID is required")
		return
	}

	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Parse request
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
	// Get turn ID from route param
	turnID := r.PathValue("id")
	if turnID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Turn ID is required")
		return
	}

	// Call service
	turns, err := h.conversationService.GetTurnPath(r.Context(), turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, turns)
}

// GetTurnSiblings retrieves all sibling turns (including self) for version browsing
// GET /api/turns/{id}/siblings
func (h *ChatHandler) GetTurnSiblings(w http.ResponseWriter, r *http.Request) {
	// Get turn ID from route param
	turnID := r.PathValue("id")
	if turnID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Turn ID is required")
		return
	}

	// Call service
	siblings, err := h.conversationService.GetTurnSiblings(r.Context(), turnID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, siblings)
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
// GET /api/chats/{id}/turns?from_turn_id=X&limit=100&direction=both
func (h *ChatHandler) GetPaginatedTurns(w http.ResponseWriter, r *http.Request) {
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

	// Parse limit (default 100)
	limit := 100
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	// Parse direction (no default here; repository applies defaults based on from_turn_id presence)
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
	// Get turn ID from route param
	turnID := r.PathValue("id")
	if turnID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Turn ID is required")
		return
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid turn ID format")
		return
	}

	// Get turn with blocks from service (follows Clean Architecture)
	turn, err := h.conversationService.GetTurnWithBlocks(r.Context(), turnID)
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

// InterruptTurn cancels a streaming turn
// POST /api/turns/{id}/interrupt
func (h *ChatHandler) InterruptTurn(w http.ResponseWriter, r *http.Request) {
	// Get turn ID from route param
	turnID := r.PathValue("id")
	if turnID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Turn ID is required")
		return
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid turn ID format")
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
	NewSSEHandler(h.registry, h.logger).StreamTurn(w, r)
}
