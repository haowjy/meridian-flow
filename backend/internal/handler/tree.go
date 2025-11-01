package handler

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain/services"
)

// TreeHandler handles HTTP requests for tree operations
type TreeHandler struct {
	treeService services.TreeService
	logger      *slog.Logger
}

// NewTreeHandler creates a new tree handler
func NewTreeHandler(treeService services.TreeService, logger *slog.Logger) *TreeHandler {
	return &TreeHandler{
		treeService: treeService,
		logger:      logger,
	}
}

// GetTree returns the nested folder/document tree for a project
func (h *TreeHandler) GetTree(c *fiber.Ctx) error {
	// Get project ID from context (injected by auth middleware)
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Build the tree
	tree, err := h.treeService.GetProjectTree(c.Context(), projectID)
	if err != nil {
		return mapErrorToHTTP(err)
	}

	return c.JSON(tree)
}
