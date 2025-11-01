package handler

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain/services"
)

// DocumentHandler handles document HTTP requests
type DocumentHandler struct {
	docService services.DocumentService
	logger     *slog.Logger
}

// NewDocumentHandler creates a new document handler
func NewDocumentHandler(docService services.DocumentService, logger *slog.Logger) *DocumentHandler {
	return &DocumentHandler{
		docService: docService,
		logger:     logger,
	}
}

// CreateDocument creates a new document
// POST /api/documents
func (h *DocumentHandler) CreateDocument(c *fiber.Ctx) error {
	// Extract project ID from context
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse request
	var req services.CreateDocumentRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.ProjectID = projectID

	// Call service (all business logic is here)
	doc, err := h.docService.CreateDocument(c.Context(), &req)
	if err != nil {
		return mapErrorToHTTP(err)
	}

	return c.Status(fiber.StatusCreated).JSON(doc)
}

// GetDocument retrieves a document by ID
// GET /api/documents/:id
func (h *DocumentHandler) GetDocument(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	doc, err := h.docService.GetDocument(c.Context(), id, projectID)
	if err != nil {
		return mapErrorToHTTP(err)
	}

	return c.JSON(doc)
}

// UpdateDocument updates a document
// PUT /api/documents/:id
func (h *DocumentHandler) UpdateDocument(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	var req services.UpdateDocumentRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.ProjectID = projectID

	doc, err := h.docService.UpdateDocument(c.Context(), id, &req)
	if err != nil {
		return mapErrorToHTTP(err)
	}

	return c.JSON(doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/:id
func (h *DocumentHandler) DeleteDocument(c *fiber.Ctx) error {
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Document ID is required")
	}

	if err := h.docService.DeleteDocument(c.Context(), id, projectID); err != nil {
		return mapErrorToHTTP(err)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

// HealthCheck is a simple health check endpoint
func (h *DocumentHandler) HealthCheck(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"status": "ok",
		"time":   time.Now(),
	})
}
