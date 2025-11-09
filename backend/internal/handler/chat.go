package handler

import (
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmSvc "meridian/internal/domain/services/llm"
)

// ChatHandler handles chat HTTP requests
type ChatHandler struct {
	chatService llmSvc.ChatService
	logger      *slog.Logger
}

// NewChatHandler creates a new chat handler
func NewChatHandler(chatService llmSvc.ChatService, logger *slog.Logger) *ChatHandler {
	return &ChatHandler{
		chatService: chatService,
		logger:      logger,
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
	turn, err := h.chatService.CreateTurn(c.Context(), &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.Status(fiber.StatusCreated).JSON(turn)
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
	turns, err := h.chatService.GetTurnPath(c.Context(), turnID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(turns)
}

// GetTurnChildren retrieves all child turns (branches) from a previous turn
// GET /api/turns/:id/children
func (h *ChatHandler) GetTurnChildren(c *fiber.Ctx) error {
	// Get previous turn ID from route param
	prevTurnID := c.Params("id")
	if prevTurnID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Previous turn ID is required")
	}

	// Call service
	turns, err := h.chatService.GetTurnChildren(c.Context(), prevTurnID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(turns)
}
