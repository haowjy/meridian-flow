package handler

import (
	"log/slog"
	"net/http"

	docsystem "meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
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
func (h *FolderHandler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	// Parse request body
	var req docsysSvc.CreateFolderRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate project_id from request body
	if req.ProjectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)
	req.UserID = userID

	// Call service
	folder, err := h.folderService.CreateFolder(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, func(id string) (*docsystem.Folder, error) {
			return h.folderService.GetFolder(r.Context(), userID, id)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, folder)
}

// GetFolder retrieves a folder by ID with its computed path
// GET /api/folders/{id}
func (h *FolderHandler) GetFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Folder ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	folder, err := h.folderService.GetFolder(r.Context(), userID, id)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, folder)
}

// UpdateFolder updates a folder (rename or move)
// PATCH /api/folders/{id}
func (h *FolderHandler) UpdateFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Folder ID")
	if !ok {
		return
	}

	var req docsysSvc.UpdateFolderRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	folder, err := h.folderService.UpdateFolder(r.Context(), userID, id, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, folder)
}

// DeleteFolder deletes a folder (must be empty)
// DELETE /api/folders/{id}
func (h *FolderHandler) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Folder ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	if err := h.folderService.DeleteFolder(r.Context(), userID, id); err != nil {
		handleError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListChildren lists all child folders and documents in a folder
// GET /api/folders/{id}/children?project_id=xxx
func (h *FolderHandler) ListChildren(w http.ResponseWriter, r *http.Request) {
	// Get project_id from query parameter (consistent with import, search, ListChats)
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	id := r.PathValue("id")
	var folderID *string
	if id != "" {
		folderID = &id
	}

	contents, err := h.folderService.ListChildren(r.Context(), userID, folderID, projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, contents)
}
