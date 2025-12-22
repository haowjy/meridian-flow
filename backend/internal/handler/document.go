package handler

import (
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

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
		HandleCreateConflict(w, err, func(id string) (*docsystem.Document, error) {
			return h.docService.GetDocument(r.Context(), userID, id)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, doc)
}

// GetDocument retrieves a document by ID
// GET /api/documents/{id}
func (h *DocumentHandler) GetDocument(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Document ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	doc, err := h.docService.GetDocument(r.Context(), userID, id)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// updateDocumentDTO is the transport-layer request for PATCH /api/documents/{id}.
// Uses httputil.OptionalString for folder_id and ai_version to support tri-state PATCH semantics (RFC 7396):
//   - field absent = don't change
//   - field null = clear (ai_version) / move to root (folder_id)
//   - field has value = set
type updateDocumentDTO struct {
	ProjectID  string                  `json:"project_id"`
	Name       *string                 `json:"name,omitempty"`
	FolderPath *string                 `json:"folder_path,omitempty"`
	FolderID   httputil.OptionalString `json:"folder_id"`
	Content    *string                 `json:"content,omitempty"`
	AIVersion  httputil.OptionalString `json:"ai_version"`
}

// UpdateDocument updates a document
// PATCH /api/documents/{id}
func (h *DocumentHandler) UpdateDocument(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Document ID")
	if !ok {
		return
	}

	var dto updateDocumentDTO
	if err := httputil.ParseJSON(w, r, &dto); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate: empty string is not valid for folder_id - use null to move to root
	if dto.FolderID.Present && dto.FolderID.Value != nil && *dto.FolderID.Value == "" {
		httputil.RespondError(w, http.StatusBadRequest, "folder_id cannot be empty string; use null to move to root")
		return
	}

	// Map transport DTO to service request
	req := &docsysSvc.UpdateDocumentRequest{
		ProjectID:  dto.ProjectID,
		Name:       dto.Name,
		FolderPath: dto.FolderPath,
		FolderID: docsysSvc.OptionalFolderID{
			Present: dto.FolderID.Present,
			Value:   dto.FolderID.Value,
		},
		Content: dto.Content,
		AIVersion: docsysSvc.OptionalAIVersion{
			Present: dto.AIVersion.Present,
			Value:   dto.AIVersion.Value,
		},
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	doc, err := h.docService.UpdateDocument(r.Context(), userID, id, req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/{id}
func (h *DocumentHandler) DeleteDocument(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Document ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	if err := h.docService.DeleteDocument(r.Context(), userID, id); err != nil {
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

	// Parse optional limit/offset parameters
	req.Limit = QueryInt(r, "limit", 0, 1, 1000)   // 0 = use service default
	req.Offset = QueryInt(r, "offset", 0, 0, math.MaxInt)

	// Parse optional language parameter (default handled by service/repository)
	if language := r.URL.Query().Get("language"); language != "" {
		req.Language = language
	}

	// Parse optional folder_id parameter
	if folderID := r.URL.Query().Get("folder_id"); folderID != "" {
		req.FolderID = &folderID
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Call service
	results, err := h.docService.SearchDocuments(r.Context(), userID, req)
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
