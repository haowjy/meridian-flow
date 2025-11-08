package handler

import (
	"errors"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain"
	docsystem "meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// FolderHandler handles folder HTTP requests
type FolderHandler struct {
	folderService docsysSvc.FolderService
	logger        *slog.Logger
}

// NewFolderHandler creates a new folder handler
func NewFolderHandler(folderService docsysSvc.FolderService, logger *slog.Logger) *FolderHandler {
	return &FolderHandler{
		folderService: folderService,
		logger:        logger,
	}
}

// CreateFolder creates a new folder
// POST /api/folders
// Returns 201 if created, 409 with existing folder if duplicate
func (h *FolderHandler) CreateFolder(c *fiber.Ctx) error {
	// Extract project ID from context
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse request
	var req docsysSvc.CreateFolderRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.ProjectID = projectID

	// Call service
	folder, err := h.folderService.CreateFolder(c.Context(), &req)
	if err != nil {
		// Handle conflict by fetching and returning existing folder with 409
		return HandleCreateConflict(c, err, func() (*docsystem.Folder, error) {
			// Get ConflictError to extract resource ID
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.folderService.GetFolder(c.Context(), conflictErr.ResourceID, projectID)
			}
			return nil, err
		})
	}

	return c.Status(fiber.StatusCreated).JSON(folder)
}

// GetFolder retrieves a folder by ID with its computed path
// GET /api/folders/:id
func (h *FolderHandler) GetFolder(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
	}

	folder, err := h.folderService.GetFolder(c.Context(), id, projectID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(folder)
}

// UpdateFolder updates a folder (rename or move)
// PATCH /api/folders/:id
func (h *FolderHandler) UpdateFolder(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
	}

	var req docsysSvc.UpdateFolderRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.ProjectID = projectID

	folder, err := h.folderService.UpdateFolder(c.Context(), id, &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(folder)
}

// DeleteFolder deletes a folder (must be empty)
// DELETE /api/folders/:id
func (h *FolderHandler) DeleteFolder(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
	}

	if err := h.folderService.DeleteFolder(c.Context(), id, projectID); err != nil {
		return handleError(c, err)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

// ListChildren lists all child folders and documents in a folder
// GET /api/folders/:id/children (or /api/folders for root)
func (h *FolderHandler) ListChildren(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	var folderID *string
	if id != "" {
		folderID = &id
	}

	contents, err := h.folderService.ListChildren(c.Context(), folderID, projectID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(contents)
}
