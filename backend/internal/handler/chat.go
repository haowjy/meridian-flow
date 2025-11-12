package handler

import (
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
	"meridian/internal/service/llm/streaming"
)

// ChatHandler handles chat HTTP requests
type ChatHandler struct {
	chatService         llmSvc.ChatService
	conversationService llmSvc.ConversationService
	streamingService    llmSvc.StreamingService
	turnRepo            llmRepo.TurnRepository
	registry            *streaming.TurnExecutorRegistry
	logger              *slog.Logger
}

// NewChatHandler creates a new chat handler
func NewChatHandler(
	chatService llmSvc.ChatService,
	conversationService llmSvc.ConversationService,
	streamingService llmSvc.StreamingService,
	turnRepo llmRepo.TurnRepository,
	registry *streaming.TurnExecutorRegistry,
	logger *slog.Logger,
) *ChatHandler {
	return &ChatHandler{
		chatService:         chatService,
		conversationService: conversationService,
		streamingService:    streamingService,
		turnRepo:            turnRepo,
		registry:            registry,
		logger:              logger,
	}
}

// CreateChat creates a new chat session
// POST /api/chats
// Returns 201 if created, 409 with existing chat if duplicate
func (h *ChatHandler) CreateChat(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse request
	var req llmSvc.CreateChatRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.UserID = userID

	// Call service
	chat, err := h.chatService.CreateChat(c.Context(), &req)
	if err != nil {
		// Handle conflict by fetching and returning existing chat with 409
		return HandleCreateConflict(c, err, func() (*llmModels.Chat, error) {
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.chatService.GetChat(c.Context(), conflictErr.ResourceID, userID)
			}
			return nil, err
		})
	}

	return c.Status(fiber.StatusCreated).JSON(chat)
}

// ListChats retrieves all chats for a project
// GET /api/chats?project_id=:id
func (h *ChatHandler) ListChats(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Get project ID from query param
	projectID := c.Query("project_id")
	if projectID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "project_id query parameter is required")
	}

	// Call service
	chats, err := h.chatService.ListChats(c.Context(), projectID, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(chats)
}

// GetChat retrieves a single chat by ID
// GET /api/chats/:id
func (h *ChatHandler) GetChat(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Call service
	chat, err := h.chatService.GetChat(c.Context(), chatID, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(chat)
}

// UpdateChat updates a chat's title
// PATCH /api/chats/:id
func (h *ChatHandler) UpdateChat(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Parse request
	var req llmSvc.UpdateChatRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	// Call service
	chat, err := h.chatService.UpdateChat(c.Context(), chatID, userID, &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(chat)
}

// DeleteChat soft-deletes a chat
// DELETE /api/chats/:id
func (h *ChatHandler) DeleteChat(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Call service
	deletedChat, err := h.chatService.DeleteChat(c.Context(), chatID, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.Status(fiber.StatusOK).JSON(deletedChat)
}

// CreateTurn creates a new turn (user message)
// POST /api/chats/:id/turns
func (h *ChatHandler) CreateTurn(c *fiber.Ctx) error {
	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse request
	var req llmSvc.CreateTurnRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.ChatID = chatID
	req.UserID = userID

	// Call service
	response, err := h.streamingService.CreateTurn(c.Context(), &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.Status(fiber.StatusCreated).JSON(response)
}

// GetTurnPath retrieves the conversation path from a turn to root
// GET /api/turns/:id/path
func (h *ChatHandler) GetTurnPath(c *fiber.Ctx) error {
	// Get turn ID from route param
	turnID := c.Params("id")
	if turnID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Turn ID is required")
	}

	// Call service
	turns, err := h.conversationService.GetTurnPath(c.Context(), turnID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(turns)
}

// GetTurnSiblings retrieves all sibling turns (including self) for version browsing
// GET /api/turns/:id/siblings
func (h *ChatHandler) GetTurnSiblings(c *fiber.Ctx) error {
	// Get turn ID from route param
	turnID := c.Params("id")
	if turnID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Turn ID is required")
	}

	// Call service
	siblings, err := h.conversationService.GetTurnSiblings(c.Context(), turnID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(siblings)
}

// GetPaginatedTurns retrieves turns and blocks in paginated fashion
// GET /api/chats/:id/turns?from_turn_id=X&limit=100&direction=both
func (h *ChatHandler) GetPaginatedTurns(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Parse query parameters
	fromTurnIDStr := c.Query("from_turn_id")
	var fromTurnID *string
	if fromTurnIDStr != "" {
		fromTurnID = &fromTurnIDStr
	}

	// Parse limit (default 100)
	limit := c.QueryInt("limit", 100)

	// Parse direction (default "both")
	direction := c.Query("direction", "both")

	// Call service
	response, err := h.conversationService.GetPaginatedTurns(c.Context(), chatID, userID, fromTurnID, limit, direction)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(response)
}

// GetTurnBlocks retrieves all completed turn blocks for a turn
// GET /api/turns/:id/blocks
// Used for reconnection - client fetches completed blocks before connecting to SSE stream
func (h *ChatHandler) GetTurnBlocks(c *fiber.Ctx) error {
	// Get turn ID from route param
	turnID := c.Params("id")
	if turnID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Turn ID is required")
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid turn ID format")
	}

	// Get blocks from repository
	blocks, err := h.turnRepo.GetTurnBlocks(c.Context(), turnID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(blocks)
}

// InterruptTurn cancels a streaming turn
// POST /api/turns/:id/interrupt
func (h *ChatHandler) InterruptTurn(c *fiber.Ctx) error {
	// Get turn ID from route param
	turnID := c.Params("id")
	if turnID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Turn ID is required")
	}

	// Validate turn ID format
	if _, err := uuid.Parse(turnID); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid turn ID format")
	}

	// Get executor from registry
	executor := h.registry.Get(turnID)
	if executor == nil {
		return fiber.NewError(fiber.StatusNotFound, "Turn is not currently streaming")
	}

	// Interrupt the executor
	executor.Interrupt()

	// Update turn status in database (executor will do this, but do it here for immediate feedback)
	if err := h.turnRepo.UpdateTurnStatus(c.Context(), turnID, "cancelled", nil); err != nil {
		// Log error but don't fail - executor will update status
		h.logger.Warn("failed to update turn status on interrupt", "turn_id", turnID, "error", err)
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"success": true,
		"turn_id": turnID,
		"status":  "cancelled",
	})
}

// StreamTurn streams turn deltas via Server-Sent Events (SSE)
// GET /api/turns/:id/stream
func (h *ChatHandler) StreamTurn(c *fiber.Ctx) error {
	return NewSSEHandler(h.registry, h.logger).StreamTurn(c)
}
