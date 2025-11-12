package handler

// chat_debug.go - Debug-only endpoints for testing assistant turn creation
// These handlers are always compiled but only registered when ENVIRONMENT=dev

import (
	"meridian/internal/config"
	llmSvc "meridian/internal/domain/services/llm"

	"github.com/gofiber/fiber/v2"
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
// POST /debug/api/chats/:id/turns
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
func (h *ChatDebugHandler) CreateAssistantTurn(c *fiber.Ctx) error {
	// Get chat ID from route param
	chatID := c.Params("id")
	if chatID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Chat ID is required")
	}

	// Get userID from context (set by auth middleware)
	userID := c.Locals("userID").(string)

	// Parse request
	var req struct {
		PrevTurnID    *string                    `json:"prev_turn_id"`
		Role          string                     `json:"role"`
		TurnBlocks []llmSvc.TurnBlockInput `json:"turn_blocks"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	// Validate role is assistant
	if req.Role != "assistant" {
		return fiber.NewError(fiber.StatusBadRequest, "Debug endpoint only accepts role='assistant'")
	}

	// Create assistant turn via debug service method
	model := h.config.DefaultModel
	if model == "" {
		model = "claude-haiku-4-5-20251001" // Fallback if config not set
	}
	turn, err := h.streamingService.CreateAssistantTurnDebug(c.Context(), chatID, userID, req.PrevTurnID, req.TurnBlocks, model)
	if err != nil {
		return handleError(c, err)
	}

	return c.Status(fiber.StatusCreated).JSON(turn)
}

// GetChatTree retrieves the complete conversation tree structure (DEBUG ONLY)
// GET /debug/api/chats/:id/tree
//
// WARNING: This endpoint is DEBUG ONLY and should NEVER be used in production.
// Production code should use the pagination endpoint (/api/chats/:id/turns) which
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
func (h *ChatDebugHandler) GetChatTree(c *fiber.Ctx) error {
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
	tree, err := h.conversationService.GetChatTree(c.Context(), chatID, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(tree)
}
