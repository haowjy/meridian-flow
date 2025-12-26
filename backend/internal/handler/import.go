package handler

import (
	"fmt"
	"log/slog"
	"net/http"

	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
)

// ImportHandler handles bulk import HTTP requests.
//
// Supports two modes:
//   - Merge: Upserts documents (creates new, optionally updates existing)
//   - Replace: Deletes all project documents first, then imports
type ImportHandler struct {
	importService docsysSvc.ImportService
	authorizer    services.ResourceAuthorizer
	logger        *slog.Logger
}

// NewImportHandler creates a new import handler
func NewImportHandler(importService docsysSvc.ImportService, authorizer services.ResourceAuthorizer, logger *slog.Logger) *ImportHandler {
	return &ImportHandler{
		importService: importService,
		authorizer:    authorizer,
		logger:        logger,
	}
}

// importOptions configures the import operation
type importOptions struct {
	deleteFirst bool // If true, delete all existing documents before import
	overwrite   bool // If true, update existing documents; if false, skip duplicates
}

// ImportResponse represents the response for import operations
type ImportResponse struct {
	Success   bool                       `json:"success"`
	Summary   docsysSvc.ImportSummary    `json:"summary"`
	Errors    []docsysSvc.ImportError    `json:"errors"`
	Documents []docsysSvc.ImportDocument `json:"documents"`
}

// Merge handles bulk import in merge mode (upserts documents).
// POST /api/import
//
// Query parameters:
//   - project_id: required
//   - folder_path: optional, target folder path (empty = root)
//   - overwrite: optional, if "true" updates existing documents
func (h *ImportHandler) Merge(w http.ResponseWriter, r *http.Request) {
	overwrite := r.URL.Query().Get("overwrite") == "true"
	h.processImportRequest(w, r, importOptions{
		deleteFirst: false,
		overwrite:   overwrite,
	})
}

// Replace handles bulk import in replace mode (deletes all documents then imports).
// POST /api/import/replace
//
// Query parameters:
//   - project_id: required
//   - folder_path: optional, target folder path (empty = root)
func (h *ImportHandler) Replace(w http.ResponseWriter, r *http.Request) {
	h.processImportRequest(w, r, importOptions{
		deleteFirst: true,
		overwrite:   true, // Always overwrite in replace mode (though irrelevant since we delete first)
	})
}

// processImportRequest handles common import logic for both merge and replace modes.
// Extracts project/user IDs, validates authorization, parses files, and processes import.
func (h *ImportHandler) processImportRequest(w http.ResponseWriter, r *http.Request, opts importOptions) {
	// Get project ID from query parameter
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Verify user owns the project before importing
	if err := h.authorizer.CanAccessProject(r.Context(), userID, projectID); err != nil {
		handleError(w, err)
		return
	}

	// Parse multipart form (max 100MB for zip files)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Failed to parse multipart form")
		return
	}

	// Get files from form
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "No files provided")
		return
	}

	// Get folder path from query parameter (empty string = root level)
	folderPath := r.URL.Query().Get("folder_path")

	// Determine mode label for logging
	mode := "merge"
	if opts.deleteFirst {
		mode = "replace"
	}

	h.logger.Info("starting import",
		"mode", mode,
		"project_id", projectID,
		"file_count", len(files),
		"folder_path", folderPath,
		"overwrite", opts.overwrite,
	)

	// Delete all documents first if in replace mode
	if opts.deleteFirst {
		if err := h.importService.DeleteAllDocuments(r.Context(), projectID); err != nil {
			h.logger.Error("failed to delete all documents",
				"project_id", projectID,
				"error", err,
			)
			handleError(w, err)
			return
		}
		h.logger.Info("deleted all documents", "project_id", projectID)
	}

	// Convert uploaded files to UploadedFile slice.
	// Note: defer file.Close() is safe here because all files are processed
	// before this function returns.
	uploadedFiles := make([]docsysSvc.UploadedFile, 0, len(files))
	for _, fileHeader := range files {
		file, err := fileHeader.Open()
		if err != nil {
			h.logger.Error("failed to open uploaded file",
				"file", fileHeader.Filename,
				"error", err,
			)
			httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("failed to open file %s", fileHeader.Filename))
			return
		}
		defer func() { _ = file.Close() }() // Error ignored: file already processed

		uploadedFiles = append(uploadedFiles, docsysSvc.UploadedFile{
			Filename: fileHeader.Filename,
			Content:  file,
		})
	}

	// Process files using file processor strategies
	result, err := h.importService.ProcessFiles(r.Context(), projectID, userID, uploadedFiles, folderPath, opts.overwrite)
	if err != nil {
		h.logger.Error("failed to process files", "error", err)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to process files")
		return
	}

	h.logger.Info("import complete",
		"mode", mode,
		"project_id", projectID,
		"created", result.Summary.Created,
		"updated", result.Summary.Updated,
		"skipped", result.Summary.Skipped,
		"failed", result.Summary.Failed,
	)

	// Build response
	response := ImportResponse{
		Success:   result.Summary.Failed == 0,
		Summary:   result.Summary,
		Errors:    result.Errors,
		Documents: result.Documents,
	}

	httputil.RespondJSON(w, http.StatusOK, response)
}
