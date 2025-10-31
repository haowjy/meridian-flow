package handlers

import (
	"log"
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
// POST /api/documents
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
	var req models.CreateDocumentRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	// Validate path
	normalizedPath := utils.NormalizePath(req.Path)
	if err := utils.ValidatePath(normalizedPath); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}

	// Check if document with this path already exists
	existing, err := h.db.GetDocumentByPath(normalizedPath, h.projectID)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to check existing document")
	}
	if existing != nil {
		return fiber.NewError(fiber.StatusConflict, "Document with this path already exists")
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
		Path:            normalizedPath,
		ContentTipTap:   req.ContentTipTap,
		ContentMarkdown: markdown,
		WordCount:       wordCount,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}

	if err := h.db.CreateDocument(doc); err != nil {
		log.Printf("Error creating document: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to create document")
	}

	return c.Status(fiber.StatusCreated).JSON(doc)
}

// ListDocuments retrieves all documents in the project
// GET /api/documents
func (h *DocumentHandler) ListDocuments(c *fiber.Ctx) error {
	documents, err := h.db.ListDocuments(h.projectID)
	if err != nil {
		log.Printf("Error listing documents: %v", err)
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to list documents")
	}

	if documents == nil {
		documents = []models.Document{}
	}

	response := models.DocumentListResponse{
		Documents: documents,
		Total:     len(documents),
	}

	return c.JSON(response)
}

// GetDocument retrieves a single document
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

	return c.JSON(doc)
}

// UpdateDocument updates an existing document
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

	// Update path if provided
	if req.Path != nil {
		normalizedPath := utils.NormalizePath(*req.Path)
		if err := utils.ValidatePath(normalizedPath); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, err.Error())
		}

		// Check if a different document with this path already exists
		if normalizedPath != doc.Path {
			existing, err := h.db.GetDocumentByPath(normalizedPath, h.projectID)
			if err != nil {
				return fiber.NewError(fiber.StatusInternalServerError, "Failed to check existing document")
			}
			if existing != nil && existing.ID != doc.ID {
				return fiber.NewError(fiber.StatusConflict, "Document with this path already exists")
			}
		}

		doc.Path = normalizedPath
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
		return fiber.NewError(fiber.StatusInternalServerError, "Failed to update document")
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

