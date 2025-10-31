package handlers

import (
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/jimmyyao/meridian/backend/internal/utils"
)

// CreateFolder creates a new folder
func CreateFolder(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get project ID from context
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
		}

		// Parse request body
		var req models.CreateFolderRequest
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
		}

		// Validate folder name
		if err := utils.ValidateFolderName(req.Name); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}

		// Create folder
		folder := &models.Folder{
			ProjectID: projectID,
			ParentID:  req.ParentID,
			Name:      req.Name,
			CreatedAt: time.Now(),
		}

		if err := db.CreateFolder(folder); err != nil {
			if strings.Contains(err.Error(), "already exists") {
				return fiber.NewError(fiber.StatusConflict, err.Error())
			}
			return fiber.NewError(fiber.StatusInternalServerError, "Failed to create folder: "+err.Error())
		}

		return c.Status(fiber.StatusCreated).JSON(folder)
	}
}

// GetFolder retrieves a single folder with its immediate children
func GetFolder(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get project ID from context
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
		}

		// Get folder ID from URL
		folderID := c.Params("id")
		if folderID == "" {
			return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
		}

		// Get folder
		folder, err := db.GetFolder(folderID, projectID)
		if err != nil {
			return fiber.NewError(fiber.StatusNotFound, err.Error())
		}

		// Get immediate children (folders)
		childFolders, err := db.ListFolderChildren(&folderID, projectID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, err.Error())
		}

		// Get documents in this folder
		documents, err := db.ListDocumentsInFolder(&folderID, projectID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, err.Error())
		}

		// Build response
		response := fiber.Map{
			"folder":    folder,
			"folders":   childFolders,
			"documents": documents,
		}

		return c.JSON(response)
	}
}

// UpdateFolder updates a folder (rename or move)
func UpdateFolder(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get project ID from context
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
		}

		// Get folder ID from URL
		folderID := c.Params("id")
		if folderID == "" {
			return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
		}

		// Get existing folder
		folder, err := db.GetFolder(folderID, projectID)
		if err != nil {
			return fiber.NewError(fiber.StatusNotFound, err.Error())
		}

		// Parse request body
		var req models.UpdateFolderRequest
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
		}

		// Update fields if provided
		if req.Name != nil {
			if err := utils.ValidateFolderName(*req.Name); err != nil {
				return fiber.NewError(fiber.StatusBadRequest, err.Error())
			}
			folder.Name = *req.Name
		}

		if req.ParentID != nil {
			folder.ParentID = req.ParentID
		}

		// Update folder in database
		if err := db.UpdateFolder(folder); err != nil {
			if strings.Contains(err.Error(), "already exists") {
				return fiber.NewError(fiber.StatusConflict, err.Error())
			}
			return fiber.NewError(fiber.StatusInternalServerError, "Failed to update folder: "+err.Error())
		}

		return c.JSON(folder)
	}
}

// DeleteFolder deletes a folder
func DeleteFolder(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get project ID from context
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
		}

		// Get folder ID from URL
		folderID := c.Params("id")
		if folderID == "" {
			return fiber.NewError(fiber.StatusBadRequest, "Folder ID is required")
		}

		// Delete folder
		if err := db.DeleteFolder(folderID, projectID); err != nil {
			return fiber.NewError(fiber.StatusNotFound, err.Error())
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}
