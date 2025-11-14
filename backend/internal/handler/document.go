package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"meridian/internal/domain"
	docsystem "meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
)

// DocumentHandler handles document HTTP requests
type DocumentHandler struct {
	docService docsysSvc.DocumentService
	logger     *slog.Logger
}

// NewDocumentHandler creates a new document handler
func NewDocumentHandler(docService docsysSvc.DocumentService, logger *slog.Logger) *DocumentHandler {
	return &DocumentHandler{
		docService: docService,
		logger:     logger,
	}
}

// CreateDocument creates a new document
// POST /api/documents
// Returns 201 if created, 409 with existing document if duplicate
func (h *DocumentHandler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	// Extract project ID from context
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Parse request
	var req docsysSvc.CreateDocumentRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ProjectID = projectID
	req.UserID = userID

	// Call service (all business logic is here)
	doc, err := h.docService.CreateDocument(r.Context(), &req)
	if err != nil {
		// Handle conflict by fetching and returning existing document with 409
		HandleCreateConflict(w, err, func() (*docsystem.Document, error) {
			// Get ConflictError to extract resource ID
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.docService.GetDocument(r.Context(), conflictErr.ResourceID, projectID)
			}
			return nil, err
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, doc)
}

// GetDocument retrieves a document by ID
// GET /api/documents/{id}
func (h *DocumentHandler) GetDocument(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Document ID is required")
		return
	}

	doc, err := h.docService.GetDocument(r.Context(), id, projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// UpdateDocument updates a document
// PATCH /api/documents/{id}
func (h *DocumentHandler) UpdateDocument(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Document ID is required")
		return
	}

	var req docsysSvc.UpdateDocumentRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ProjectID = projectID

	doc, err := h.docService.UpdateDocument(r.Context(), id, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/{id}
func (h *DocumentHandler) DeleteDocument(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Document ID is required")
		return
	}

	if err := h.docService.DeleteDocument(r.Context(), id, projectID); err != nil {
		handleError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// HealthCheck is a simple health check endpoint
func (h *DocumentHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"time":   time.Now(),
	})
}
