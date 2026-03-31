package handler

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/config"
	"meridian/internal/domain"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/httputil"
	"meridian/internal/optional"
)

// ThreadHandler handles thread HTTP requests
// Follows Clean Architecture: handlers only communicate with services, never repositories
type ThreadHandler struct {
	threadService        domainllm.ThreadService
	threadHistoryService domainllm.ThreadHistoryService
	streamingService     domainllm.StreamingService
	registry             *mstream.Registry
	logger               *slog.Logger
	config               *config.Config
}

// NewThreadHandler creates a new thread handler
func NewThreadHandler(
	threadService domainllm.ThreadService,
	threadHistoryService domainllm.ThreadHistoryService,
	streamingService domainllm.StreamingService,
	registry *mstream.Registry,
	logger *slog.Logger,
	cfg *config.Config,
) *ThreadHandler {
	return &ThreadHandler{
		threadService:        threadService,
		threadHistoryService: threadHistoryService,
		streamingService:     streamingService,
		registry:             registry,
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
	var req domainllm.CreateThreadRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service
	thread, err := h.threadService.CreateThread(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, h.config, func(id string) (*domainllm.Thread, error) {
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

// threadDetailResponse wraps a Thread with computed fields for the detail view.
// Spawn fields (parent_thread_id, spawn_status, spawn_result, spawn_depth) come from
// the Thread domain object; children_count is computed here to avoid an extra DB round-trip
// on list endpoints.
type threadDetailResponse struct {
	*domainllm.Thread
	ChildrenCount int `json:"children_count"`
}

type createTurnHTTPResponse struct {
	Thread        *domainllm.Thread `json:"thread,omitempty"`
	UserTurn      *domainllm.Turn   `json:"user_turn"`
	AssistantTurn *domainllm.Turn   `json:"assistant_turn"`
}

type upsertInterjectionHTTPResponse struct {
	Mode string `json:"mode"`

	AssistantTurnID string `json:"assistantTurnId,omitempty"`
	Content         string `json:"content,omitempty"`
	Length          int    `json:"length,omitempty"`

	UserTurn         *domainllm.Turn `json:"userTurn,omitempty"`
	NewAssistantTurn *domainllm.Turn `json:"assistantTurn,omitempty"`
}

// GetThread retrieves a single thread by ID
// GET /api/threads/{id}
//
// Response includes spawn fields: parent_thread_id, spawn_status, spawn_result,
// spawn_depth (from Thread), and children_count (computed from child thread count).
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

	// Count child threads for spawn tracking. Non-fatal: if listing fails,
	// children_count is reported as 0 rather than failing the whole request.
	childrenCount := 0
	if children, listErr := h.threadService.ListChildThreads(r.Context(), threadID, userID); listErr == nil {
		childrenCount = len(children)
	}

	httputil.RespondJSON(w, http.StatusOK, threadDetailResponse{
		Thread:        thread,
		ChildrenCount: childrenCount,
	})
}

// UpdateThread updates a thread's title
// PATCH /api/threads/{id}
func (h *ThreadHandler) UpdateThread(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req domainllm.UpdateThreadRequest
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
		TurnID optional.Optional[string] `json:"turn_id"`
	}
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Tri-state: absent = no-op, null = clear, value = set
	if !req.TurnID.Present {
		httputil.RespondError(w, http.StatusBadRequest, domain.NewValidationErrorWithField("turn_id is required", "turn_id").Error())
		return
	}

	// Call service (all validation handled by service layer)
	if err := h.threadService.UpdateLastViewedTurn(r.Context(), threadID, userID, req.TurnID.Value); err != nil {
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
	if _, err := h.threadService.DeleteThread(r.Context(), threadID, userID); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// CreateTurnV2 creates a new turn (user message) with thread_id in request body
// POST /api/turns
//
// Thread resolution priority:
// 1. If prev_turn_id provided -> infer thread from that turn
// 2. Else if thread_id provided -> use that thread
// 3. Else if project_id provided -> create new thread (cold start)
func (h *ThreadHandler) CreateTurnV2(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)
	var req domainllm.CreateTurnRequest
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

	httputil.RespondJSON(w, http.StatusCreated, buildCreateTurnHTTPResponse(response))
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
	var req domainllm.CreateTurnRequest
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

	httputil.RespondJSON(w, http.StatusCreated, buildCreateTurnHTTPResponse(response))
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
	Blocks []domainllm.TurnBlock `json:"blocks"`
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
		Status: string(turn.Status),
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

	// Check if stream exists
	stream := h.registry.Get(turnID)
	if stream == nil {
		httputil.RespondError(w, http.StatusNotFound, "Turn is not currently streaming")
		return
	}

	// Delegate to streaming service for proper cancel handling
	// Service handles capability check and soft/hard cancel decision
	if err := h.streamingService.InterruptTurn(r.Context(), userID, turnID); err != nil {
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

// UpsertInterjectionRequest is the request body for POST /api/turns/{id}/interjection
type UpsertInterjectionRequest struct {
	Mode    string `json:"mode"`    // "append" or "replace"
	Content string `json:"content"` // interjection text
}

// UpsertInterjection adds or updates an interjection for a streaming assistant turn
// POST /api/turns/{id}/interjection
//
// If the turn is actively streaming, buffers the interjection for injection at
// the next safe boundary (after tool execution or at stream completion).
// If the turn is not streaming, falls back to creating a follow-up turn.
func (h *ThreadHandler) UpsertInterjection(w http.ResponseWriter, r *http.Request) {
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

	// Parse request body
	var req UpsertInterjectionRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if err := normalizeUpsertInterjectionRequest(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Call service
	response, err := h.streamingService.UpsertInterjection(r.Context(), userID, turnID, req.Content, req.Mode)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Return appropriate status based on mode
	if response.Mode == "queued" {
		httputil.RespondJSON(w, http.StatusAccepted, buildUpsertInterjectionHTTPResponse(response))
	} else {
		// mode == "created" (fallback path)
		httputil.RespondJSON(w, http.StatusCreated, buildUpsertInterjectionHTTPResponse(response))
	}
}

// GetInterjection retrieves the current interjection state for an assistant turn
// GET /api/turns/{id}/interjection
func (h *ThreadHandler) GetInterjection(w http.ResponseWriter, r *http.Request) {
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

	// Call service
	response, err := h.streamingService.GetInterjection(r.Context(), userID, turnID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, response)
}

// ClearInterjection removes any buffered interjection for an assistant turn
// DELETE /api/turns/{id}/interjection
func (h *ThreadHandler) ClearInterjection(w http.ResponseWriter, r *http.Request) {
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

	// Call service
	if err := h.streamingService.ClearInterjection(r.Context(), userID, turnID); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func buildCreateTurnHTTPResponse(response *domainllm.CreateTurnResponse) *createTurnHTTPResponse {
	if response == nil {
		return nil
	}

	return &createTurnHTTPResponse{
		Thread:        response.Thread,
		UserTurn:      response.UserTurn,
		AssistantTurn: response.AssistantTurn,
	}
}

func buildUpsertInterjectionHTTPResponse(response *domainllm.UpsertInterjectionResponse) *upsertInterjectionHTTPResponse {
	if response == nil {
		return nil
	}

	return &upsertInterjectionHTTPResponse{
		Mode:             response.Mode,
		AssistantTurnID:  response.AssistantTurnID,
		Content:          response.Content,
		Length:           response.Length,
		UserTurn:         response.UserTurn,
		NewAssistantTurn: response.NewAssistantTurn,
	}
}
