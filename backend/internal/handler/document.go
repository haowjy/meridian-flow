package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
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
// Note: project_id is optional for cross-project documents (future feature)
func (h *DocumentHandler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	// Parse request body
	var req docsysSvc.CreateDocumentRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)
	req.UserID = userID

	// Call service (all business logic is here)
	doc, err := h.docService.CreateDocument(r.Context(), &req)
	if err != nil {
		// Handle conflict by fetching and returning existing document with 409
		HandleCreateConflict(w, err, func() (*docsystem.Document, error) {
			// Get ConflictError to extract resource ID
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.docService.GetDocument(r.Context(), conflictErr.ResourceID, req.ProjectID)
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
	projectID, _ := getProjectID(r)

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
	projectID, _ := getProjectID(r)

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
	projectID, _ := getProjectID(r)

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

// SearchDocuments performs full-text search across documents
// GET /api/documents/search?query=dragon&project_id=uuid&fields=name,content&limit=20
func (h *DocumentHandler) SearchDocuments(w http.ResponseWriter, r *http.Request) {
	// Parse required query parameter
	query := r.URL.Query().Get("query")
	if query == "" {
		httputil.RespondError(w, http.StatusBadRequest, "query parameter is required")
		return
	}

	// Build search request
	req := &docsysSvc.SearchDocumentsRequest{
		Query:     query,
		ProjectID: r.URL.Query().Get("project_id"), // Optional - empty means search all projects
	}

	// Parse optional fields parameter (comma-separated: "name,content")
	if fieldsStr := r.URL.Query().Get("fields"); fieldsStr != "" {
		fields := strings.Split(fieldsStr, ",")
		// Trim whitespace from each field
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		req.Fields = fields
	}

	// Parse optional limit parameter (default handled by service/repository)
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if limit, err := strconv.Atoi(limitStr); err == nil && limit > 0 {
			req.Limit = limit
		}
	}

	// Parse optional offset parameter (default handled by service/repository)
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		if offset, err := strconv.Atoi(offsetStr); err == nil && offset >= 0 {
			req.Offset = offset
		}
	}

	// Parse optional language parameter (default handled by service/repository)
	if language := r.URL.Query().Get("language"); language != "" {
		req.Language = language
	}

	// Parse optional folder_id parameter
	if folderID := r.URL.Query().Get("folder_id"); folderID != "" {
		req.FolderID = &folderID
	}

	// Call service
	results, err := h.docService.SearchDocuments(r.Context(), req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, results)
}

// HealthCheck is a simple health check endpoint
func (h *DocumentHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"time":   time.Now(),
	})
}
