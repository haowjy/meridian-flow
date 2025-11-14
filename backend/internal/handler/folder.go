package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"meridian/internal/domain"
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
	// Extract project ID from context
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Parse request
	var req docsysSvc.CreateFolderRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ProjectID = projectID
	req.UserID = userID

	// Call service
	folder, err := h.folderService.CreateFolder(r.Context(), &req)
	if err != nil {
		// Handle conflict by fetching and returning existing folder with 409
		HandleCreateConflict(w, err, func() (*docsystem.Folder, error) {
			// Get ConflictError to extract resource ID
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.folderService.GetFolder(r.Context(), conflictErr.ResourceID, projectID)
			}
			return nil, err
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, folder)
}

// GetFolder retrieves a folder by ID with its computed path
// GET /api/folders/{id}
func (h *FolderHandler) GetFolder(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Folder ID is required")
		return
	}

	folder, err := h.folderService.GetFolder(r.Context(), id, projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, folder)
}

// UpdateFolder updates a folder (rename or move)
// PATCH /api/folders/{id}
func (h *FolderHandler) UpdateFolder(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Folder ID is required")
		return
	}

	var req docsysSvc.UpdateFolderRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.ProjectID = projectID

	folder, err := h.folderService.UpdateFolder(r.Context(), id, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, folder)
}

// DeleteFolder deletes a folder (must be empty)
// DELETE /api/folders/{id}
func (h *FolderHandler) DeleteFolder(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Folder ID is required")
		return
	}

	if err := h.folderService.DeleteFolder(r.Context(), id, projectID); err != nil {
		handleError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListChildren lists all child folders and documents in a folder
// GET /api/folders/{id}/children (or /api/folders for root)
func (h *FolderHandler) ListChildren(w http.ResponseWriter, r *http.Request) {
	projectID, err := getProjectID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	var folderID *string
	if id != "" {
		folderID = &id
	}

	contents, err := h.folderService.ListChildren(r.Context(), folderID, projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, contents)
}
