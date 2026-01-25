package handler

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
	llmModels "meridian/internal/domain/models/llm"
	"meridian/internal/domain/services"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/handler/sse"
	"meridian/internal/httputil"
)

// ThreadHandler handles thread HTTP requests
// Follows Clean Architecture: handlers only communicate with services, never repositories
type ThreadHandler struct {
	threadService        llmSvc.ThreadService
	threadHistoryService llmSvc.ThreadHistoryService
	streamingService     llmSvc.StreamingService
	registry             *mstream.Registry
	authorizer           services.ResourceAuthorizer
	logger               *slog.Logger
	config               *config.Config
}

// NewThreadHandler creates a new thread handler
func NewThreadHandler(
	threadService llmSvc.ThreadService,
	threadHistoryService llmSvc.ThreadHistoryService,
	streamingService llmSvc.StreamingService,
	registry *mstream.Registry,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
	cfg *config.Config,
) *ThreadHandler {
	return &ThreadHandler{
		threadService:        threadService,
		threadHistoryService: threadHistoryService,
		streamingService:     streamingService,
		registry:             registry,
		authorizer:           authorizer,
		logger:               logger,
		config:               cfg,
	}
}

// CreateThread creates a new thread session
// POST /api/threads
// Returns 201 if created, 409 with existing thread if duplicate
func (h *ThreadHandler) CreateThread(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Parse request
	var req llmSvc.CreateThreadRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service
	thread, err := h.threadService.CreateThread(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, h.config, func(id string) (*llmModels.Thread, error) {
			return h.threadService.GetThread(r.Context(), id, userID)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, thread)
}

// ListThreads retrieves all threads for a project
// GET /api/threads?project_id=:id
func (h *ThreadHandler) ListThreads(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Get project ID from query param
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Call service
	threads, err := h.threadService.ListThreads(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, threads)
}

// GetThread retrieves a single thread by ID
// GET /api/threads/{id}
func (h *ThreadHandler) GetThread(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	thread, err := h.threadService.GetThread(r.Context(), threadID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, thread)
}

// UpdateThread updates a thread's title
// PATCH /api/threads/{id}
func (h *ThreadHandler) UpdateThread(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req llmSvc.UpdateThreadRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Call service
	thread, err := h.threadService.UpdateThread(r.Context(), threadID, userID, &req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, thread)
}

// UpdateLastViewedTurn updates the last_viewed_turn_id for a thread
// PATCH /api/threads/{id}/last-viewed-turn
func (h *ThreadHandler) UpdateLastViewedTurn(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
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
	if err := h.threadService.UpdateLastViewedTurn(r.Context(), threadID, userID, req.TurnID); err != nil {
		handleError(w, err, h.config)
		return
	}

	// Return success with no body (204 No Content)
	w.WriteHeader(http.StatusNoContent)
}

// DeleteThread soft-deletes a thread
// DELETE /api/threads/{id}
func (h *ThreadHandler) DeleteThread(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	deletedThread, err := h.threadService.DeleteThread(r.Context(), threadID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, deletedThread)
}

// CreateTurnV2 creates a new turn (user message) with thread_id in request body
// POST /api/turns
//
// Thread resolution priority:
// 1. If prev_turn_id provided → infer thread from that turn
// 2. Else if thread_id provided → use that thread
// 3. Else if project_id provided → create new thread (cold start)
func (h *ThreadHandler) CreateTurnV2(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)
	var req llmSvc.CreateTurnRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service - thread_id, project_id, prev_turn_id come from body
	response, err := h.streamingService.CreateTurn(r.Context(), &req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, response)
}

// CreateTurn creates a new turn (user message) - DEPRECATED
// POST /api/threads/{id}/turns
// Use POST /api/turns instead (CreateTurnV2)
func (h *ThreadHandler) CreateTurn(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req llmSvc.CreateTurnRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ThreadID = &threadID // Convert path param to pointer
	req.UserID = userID

	// Call service
	response, err := h.streamingService.CreateTurn(r.Context(), &req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, response)
}

// GetTurnPath retrieves the conversation path from a turn to root
// GET /api/turns/{id}/path
func (h *ThreadHandler) GetTurnPath(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	turns, err := h.threadHistoryService.GetTurnPath(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, turns)
}

// GetTurnSiblings retrieves all sibling turns (including self) for version browsing
// GET /api/turns/{id}/siblings
func (h *ThreadHandler) GetTurnSiblings(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	siblings, err := h.threadHistoryService.GetTurnSiblings(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, siblings)
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
// GET /api/threads/{id}/turns?from_turn_id=X&limit=100&direction=both
func (h *ThreadHandler) GetPaginatedTurns(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
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
	response, err := h.threadHistoryService.GetPaginatedTurns(r.Context(), threadID, userID, fromTurnID, limit, direction, updateLastViewed)
	if err != nil {
		handleError(w, err, h.config)
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
func (h *ThreadHandler) GetTurnBlocks(w http.ResponseWriter, r *http.Request) {
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
	turn, err := h.threadHistoryService.GetTurnWithBlocks(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err, h.config)
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
func (h *ThreadHandler) GetTurnTokenUsage(w http.ResponseWriter, r *http.Request) {
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
	tokenUsage, err := h.threadHistoryService.GetTurnTokenUsage(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, tokenUsage)
}

// InterruptTurn cancels a streaming turn
// POST /api/turns/{id}/interrupt
//
// Behavior depends on the model's supports_streaming_cancel capability:
// - true (Anthropic): Hard cancel (stops provider, counts tokens)
// - false (some providers): Soft cancel (provider continues for accurate metadata)
func (h *ThreadHandler) InterruptTurn(w http.ResponseWriter, r *http.Request) {
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
		handleError(w, err, h.config)
		return
	}

	// Check if stream exists
	stream := h.registry.Get(turnID)
	if stream == nil {
		httputil.RespondError(w, http.StatusNotFound, "Turn is not currently streaming")
		return
	}

	// Delegate to streaming service for proper cancel handling
	// Service handles capability check and soft/hard cancel decision
	if err := h.streamingService.InterruptTurn(r.Context(), turnID); err != nil {
		h.logger.Error("failed to interrupt turn",
			"turn_id", turnID,
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to interrupt turn")
		return
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"turn_id": turnID,
		"status":  "cancelled",
	})
}

// StreamTurn streams turn deltas via Server-Sent Events (SSE)
// GET /api/turns/{id}/stream
func (h *ThreadHandler) StreamTurn(w http.ResponseWriter, r *http.Request) {
	turnID, ok := PathParam(w, r, "id", "Turn ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Authorize: check user can access this turn
	if err := h.authorizer.CanAccessTurn(r.Context(), userID, turnID); err != nil {
		handleError(w, err, h.config)
		return
	}

	// Note: SSE config is created here with defaults
	// TODO: Consider injecting SSE config at ThreadHandler creation time for better testability
	sseConfig := sse.DefaultConfig()
	NewSSEHandler(h.registry, h.logger, sseConfig).StreamTurn(w, r)
}
