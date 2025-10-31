package handlers

import (
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/jimmyyao/meridian/backend/internal/database"
	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/jimmyyao/meridian/backend/internal/utils"
)

type DocumentHandler struct {
	db        *database.DB
	projectID string
}

func NewDocumentHandler(db *database.DB, projectID string) *DocumentHandler {
	return &DocumentHandler{
		db:        db,
		projectID: projectID,
	}
}

// CreateDocument creates a new document
// Supports both path-based creation (auto-resolve folders) and direct folder_id
// POST /api/documents
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
	var req models.CreateDocumentRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	var folderID *string
	var docName string

	// Path-based creation: "Characters/Aria" → auto-create folders
	if req.Path != nil && *req.Path != "" {
		// Normalize and validate path
		normalizedPath := utils.NormalizePath(*req.Path)
		if err := utils.ValidatePath(normalizedPath); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}

		// Resolve path: create folders if needed, extract document name
		result, err := utils.ResolvePath(h.db, h.projectID, normalizedPath)
		if err != nil {
			log.Printf("Error resolving path: %v", err)
			return fiber.NewError(fiber.StatusInternalServerError, "Failed to resolve path")
		}

		folderID = result.FolderID
		docName = result.Name
	} else if req.FolderID != nil && req.Name != nil {
		// Direct folder_id creation
		if err := utils.ValidateDocumentName(*req.Name); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}

		folderID = req.FolderID
		docName = *req.Name
	} else {
		return fiber.NewError(fiber.StatusBadRequest, "Either 'path' or both 'folder_id' and 'name' must be provided")
	}

	// Convert TipTap JSON to Markdown
	markdown, err := utils.ConvertTipTapToMarkdown(req.ContentTipTap)
	if err != nil {
		log.Printf("Error converting to markdown: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to convert content to markdown")
	}

	// Count words
	wordCount := utils.CountWords(markdown)

	// Create document
	doc := &models.Document{
		ProjectID:       h.projectID,
		FolderID:        folderID,
		Name:            docName,
		ContentTipTap:   req.ContentTipTap,
		ContentMarkdown: markdown,
		WordCount:       wordCount,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}

	if err := h.db.CreateDocument(doc); err != nil {
		log.Printf("Error creating document: %v", err)
		if strings.Contains(err.Error(), "already exists") {
			return fiber.NewError(fiber.StatusConflict, err.Error())
		}
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to create document: "+err.Error())
	}

	// Compute display path for response
	path, err := h.db.GetDocumentPath(doc)
	if err != nil {
		log.Printf("Warning: failed to compute path: %v", err)
		doc.Path = docName
	} else {
		doc.Path = path
	}

	return c.Status(fiber.StatusCreated).JSON(doc)
}

// GetDocument retrieves a single document by ID (with full content)
// GET /api/documents/:id
func (h *DocumentHandler) GetDocument(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	doc, err := h.db.GetDocument(id, h.projectID)
	if err != nil {
		if err.Error() == "document not found" {
			return fiber.NewError(fiber.StatusNotFound, "Document not found")
		}
		log.Printf("Error getting document: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to get document")
	}

	folderID := "nil"
	if doc.FolderID != nil {
		folderID = *doc.FolderID
	}
	log.Printf("DEBUG GetDocument: %s has folder_id=%s", doc.Name, folderID)

	return c.JSON(doc)
}

// UpdateDocument updates an existing document
// Supports updating content, name, or folder_id (move)
// PUT /api/documents/:id
func (h *DocumentHandler) UpdateDocument(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	var req models.UpdateDocumentRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	// Get existing document
	doc, err := h.db.GetDocument(id, h.projectID)
	if err != nil {
		if err.Error() == "document not found" {
			return fiber.NewError(fiber.StatusNotFound, "Document not found")
		}
		log.Printf("Error getting document: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to get document")
	}

	// Update name if provided (rename)
	if req.Name != nil {
		if err := utils.ValidateDocumentName(*req.Name); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}
		doc.Name = *req.Name
	}

	// Update folder_id if provided (move document)
	if req.FolderID != nil {
		doc.FolderID = req.FolderID
	}

	// Update content if provided
	if req.ContentTipTap != nil {
		doc.ContentTipTap = *req.ContentTipTap

		// Regenerate markdown and word count
		markdown, err := utils.ConvertTipTapToMarkdown(doc.ContentTipTap)
		if err != nil {
			log.Printf("Error converting to markdown: %v", err)
			return fiber.NewError(fiber.StatusInternalServerError, "Failed to convert content to markdown")
		}
		doc.ContentMarkdown = markdown
		doc.WordCount = utils.CountWords(markdown)
	}

	doc.UpdatedAt = time.Now()

	if err := h.db.UpdateDocument(doc); err != nil {
		log.Printf("Error updating document: %v", err)
		if strings.Contains(err.Error(), "already exists") {
			return fiber.NewError(fiber.StatusConflict, err.Error())
		}
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to update document: "+err.Error())
	}

	// Compute display path for response
	path, err := h.db.GetDocumentPath(doc)
	if err != nil {
		log.Printf("Warning: failed to compute path: %v", err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	return c.JSON(doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/:id
func (h *DocumentHandler) DeleteDocument(c *fiber.Ctx) error {
	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	if err := h.db.DeleteDocument(id, h.projectID); err != nil {
		if err.Error() == "document not found" {
			return fiber.NewError(fiber.StatusNotFound, "Document not found")
		}
		log.Printf("Error deleting document: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to delete document")
	}

	return c.Status(fiber.StatusNoContent).Send(nil)
}

// HealthCheck is a simple health check endpoint
// GET /health
func (h *DocumentHandler) HealthCheck(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status": "ok",
		"time":   time.Now(),
	})
}
