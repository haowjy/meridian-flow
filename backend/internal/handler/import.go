package handler

import (
	"fmt"
	"log/slog"
	"net/http"

	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
)

// ImportHandler handles bulk import HTTP requests
type ImportHandler struct {
	importService docsysSvc.ImportService
	logger        *slog.Logger
}

// NewImportHandler creates a new import handler
func NewImportHandler(importService docsysSvc.ImportService, logger *slog.Logger) *ImportHandler {
	return &ImportHandler{
		importService: importService,
		logger:        logger,
	}
}

// ImportResponse represents the response for import operations
type ImportResponse struct {
	Success  bool                     `json:"success"`
	Summary  docsysSvc.ImportSummary   `json:"summary"`
	Errors   []docsysSvc.ImportError   `json:"errors"`
	Documents []docsysSvc.ImportDocument `json:"documents"`
}

// Merge handles bulk import in merge mode (upserts documents)
// POST /api/import
func (h *ImportHandler) Merge(w http.ResponseWriter, r *http.Request) {
	// Get project ID from query parameter
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Parse multipart form (max 100MB for zip files)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Failed to parse multipart form")
		return
	}

	// Get zip files from form
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "No files provided")
		return
	}

	// Get folder path from query parameter (empty string = root level)
	folderPath := r.URL.Query().Get("folder_path")

	h.logger.Info("starting merge import",
		"project_id", projectID,
		"file_count", len(files),
		"folder_path", folderPath,
	)

	// Convert uploaded files to UploadedFile slice
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
		defer file.Close()

		uploadedFiles = append(uploadedFiles, docsysSvc.UploadedFile{
			Filename: fileHeader.Filename,
			Content:  file,
		})
	}

	// Process files using file processor strategies
	result, err := h.importService.ProcessFiles(r.Context(), projectID, userID, uploadedFiles, folderPath)
	if err != nil {
		h.logger.Error("failed to process files",
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to process files")
		return
	}

	h.logger.Info("merge import complete",
		"project_id", projectID,
		"created", result.Summary.Created,
		"updated", result.Summary.Updated,
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

// Replace handles bulk import in replace mode (deletes all documents then imports)
// POST /api/import/replace
func (h *ImportHandler) Replace(w http.ResponseWriter, r *http.Request) {
	// Get project ID from query parameter
	projectID := r.URL.Query().Get("project_id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "project_id query parameter is required")
		return
	}

	// Extract user ID from context
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	// Parse multipart form (max 100MB for zip files)
	if err := r.ParseMultipartForm(100 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Failed to parse multipart form")
		return
	}

	// Get zip files from form
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "No files provided")
		return
	}

	// Get folder path from query parameter (empty string = root level)
	folderPath := r.URL.Query().Get("folder_path")

	h.logger.Info("starting replace import",
		"project_id", projectID,
		"file_count", len(files),
		"folder_path", folderPath,
	)

	// Delete all documents first
	if err := h.importService.DeleteAllDocuments(r.Context(), projectID); err != nil {
		h.logger.Error("failed to delete all documents",
			"project_id", projectID,
			"error", err,
		)
		handleError(w, err)
		return
	}

	h.logger.Info("deleted all documents",
		"project_id", projectID,
	)

	// Convert uploaded files to UploadedFile slice
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
		defer file.Close()

		uploadedFiles = append(uploadedFiles, docsysSvc.UploadedFile{
			Filename: fileHeader.Filename,
			Content:  file,
		})
	}

	// Process files using file processor strategies
	result, err := h.importService.ProcessFiles(r.Context(), projectID, userID, uploadedFiles, folderPath)
	if err != nil {
		h.logger.Error("failed to process files",
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "Failed to process files")
		return
	}

	h.logger.Info("replace import complete",
		"project_id", projectID,
		"created", result.Summary.Created,
		"updated", result.Summary.Updated,
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
