package handler

import (
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	identifier "meridian/internal/domain/identifier"
	"meridian/internal/httputil"
	"meridian/internal/optional"
)

// DocumentHandler handles document HTTP requests
type DocumentHandler struct {
	docService domaindocsys.DocumentService
	resolver   identifier.Resolver // Interface for identifier resolution (DIP)
	logger     *slog.Logger
	config     *config.Config
}

// NewDocumentHandler creates a new document handler
func NewDocumentHandler(docService domaindocsys.DocumentService, resolver identifier.Resolver, logger *slog.Logger, cfg *config.Config) *DocumentHandler {
	return &DocumentHandler{
		docService: docService,
		resolver:   resolver,
		logger:     logger,
		config:     cfg,
	}
}

func (h *DocumentHandler) resolveDocumentID(w http.ResponseWriter, r *http.Request) (string, bool) {
	identifier, ok := PathParam(w, r, "id", "Document identifier")
	if !ok {
		return "", false
	}

	// Resolve identifier (UUID works, slug returns helpful error)
	documentID, err := h.resolver.ResolveDocumentIDOnly(r.Context(), identifier)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			httputil.RespondError(w, http.StatusNotFound, "document "+identifier+" not found")
		} else if errors.Is(err, domain.ErrBadRequest) {
			httputil.RespondError(w, http.StatusBadRequest, err.Error())
		} else {
			httputil.RespondError(w, http.StatusInternalServerError, "Failed to resolve document")
		}
		return "", false
	}

	return documentID, true
}

// CreateDocument creates a new document
// POST /api/documents
// Returns 201 if created, 409 with existing document if duplicate
// Note: project_id is optional for cross-project documents (future feature)
func (h *DocumentHandler) CreateDocument(w http.ResponseWriter, r *http.Request) {
	// Parse request body
	var req domaindocsys.CreateDocumentRequest
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
		HandleCreateConflict(w, err, h.config, func(id string) (*domaindocsys.Document, error) {
			return h.docService.GetDocument(r.Context(), userID, id)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, doc)
}

// GetDocument retrieves a document by ID (UUID only)
// GET /api/documents/{id}
// Note: Slug resolution requires project context. For standalone document endpoints,
// only UUIDs work. Slugs return 400 with helpful error message.
func (h *DocumentHandler) GetDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := h.resolveDocumentID(w, r)
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	doc, err := h.docService.GetDocument(r.Context(), userID, documentID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// updateDocumentDTO is the transport-layer request for PATCH /api/documents/{id}.
// Uses optional.Optional[string] for folder_id to support tri-state PATCH semantics (RFC 7396):
//   - field absent = don't change
//   - field null = move to root (folder_id)
//   - field has value = set
type updateDocumentDTO struct {
	ProjectID  string                    `json:"project_id"`
	Name       *string                   `json:"name,omitempty"`
	Extension  *string                   `json:"extension,omitempty"` // Optional extension change (e.g., ".md" -> ".txt")
	FolderPath *string                   `json:"folder_path,omitempty"`
	FolderID   optional.Optional[string] `json:"folder_id"`
	Content    *string                   `json:"content,omitempty"`
}

// UpdateDocument updates a document
// PATCH /api/documents/{id}
func (h *DocumentHandler) UpdateDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := h.resolveDocumentID(w, r)
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
	req := &domaindocsys.UpdateDocumentRequest{
		ProjectID:  dto.ProjectID,
		Name:       dto.Name,
		Extension:  dto.Extension,
		FolderPath: dto.FolderPath,
		FolderID:   dto.FolderID,
		Content:    dto.Content,
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	doc, err := h.docService.UpdateDocument(r.Context(), userID, documentID, req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, doc)
}

// DeleteDocument deletes a document
// DELETE /api/documents/{id}
func (h *DocumentHandler) DeleteDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := h.resolveDocumentID(w, r)
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	if err := h.docService.DeleteDocument(r.Context(), userID, documentID); err != nil {
		handleError(w, err, h.config)
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
	req := &domaindocsys.SearchDocumentsRequest{
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
	req.Limit = QueryInt(r, "limit", 0, 1, 1000) // 0 = use service default
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
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, results)
}

// HealthCheck is a simple health check endpoint
func (h *DocumentHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"status": "ok",
		"time":   time.Now().UTC(),
	})
}
