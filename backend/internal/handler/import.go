package handler

import (
	"fmt"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	docsysSvc "meridian/internal/domain/services/docsystem"
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
func (h *ImportHandler) Merge(c *fiber.Ctx) error {
	// Extract project ID from context
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse multipart form
	form, err := c.MultipartForm()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Failed to parse multipart form")
	}

	// Get zip files from form
	files := form.File["files"]
	if len(files) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "No files provided")
	}

	h.logger.Info("starting merge import",
		"project_id", projectID,
		"file_count", len(files),
	)

	// Aggregate results across all files
	aggregatedResult := &docsysSvc.ImportResult{
		Summary:   docsysSvc.ImportSummary{},
		Errors:    []docsysSvc.ImportError{},
		Documents: []docsysSvc.ImportDocument{},
	}

	// Process each zip file
	for _, fileHeader := range files {
		// Validate file is a zip
		if fileHeader.Header.Get("Content-Type") != "application/zip" &&
			fileHeader.Header.Get("Content-Type") != "application/x-zip-compressed" {
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: "file is not a zip file",
			})
			aggregatedResult.Summary.Failed++
			continue
		}

		// Open file
		file, err := fileHeader.Open()
		if err != nil {
			h.logger.Error("failed to open uploaded file",
				"file", fileHeader.Filename,
				"error", err,
			)
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: fmt.Sprintf("failed to open file: %v", err),
			})
			continue
		}

		// Process zip file
		result, err := h.importService.ProcessZipFile(c.Context(), projectID, userID, file)
		file.Close()

		if err != nil {
			h.logger.Error("failed to process zip file",
				"file", fileHeader.Filename,
				"error", err,
			)
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: fmt.Sprintf("failed to process zip: %v", err),
			})
			continue
		}

		// Aggregate results
		aggregatedResult.Summary.Created += result.Summary.Created
		aggregatedResult.Summary.Updated += result.Summary.Updated
		aggregatedResult.Summary.Skipped += result.Summary.Skipped
		aggregatedResult.Summary.Failed += result.Summary.Failed
		aggregatedResult.Summary.TotalFiles += result.Summary.TotalFiles
		aggregatedResult.Errors = append(aggregatedResult.Errors, result.Errors...)
		aggregatedResult.Documents = append(aggregatedResult.Documents, result.Documents...)
	}

	h.logger.Info("merge import complete",
		"project_id", projectID,
		"created", aggregatedResult.Summary.Created,
		"updated", aggregatedResult.Summary.Updated,
		"failed", aggregatedResult.Summary.Failed,
	)

	// Build response
	response := ImportResponse{
		Success:   aggregatedResult.Summary.Failed == 0,
		Summary:   aggregatedResult.Summary,
		Errors:    aggregatedResult.Errors,
		Documents: aggregatedResult.Documents,
	}

	return c.Status(fiber.StatusOK).JSON(response)
}

// Replace handles bulk import in replace mode (deletes all documents then imports)
// POST /api/import/replace
func (h *ImportHandler) Replace(c *fiber.Ctx) error {
	// Extract project ID from context
	projectID, err := getProjectID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse multipart form
	form, err := c.MultipartForm()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Failed to parse multipart form")
	}

	// Get zip files from form
	files := form.File["files"]
	if len(files) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "No files provided")
	}

	h.logger.Info("starting replace import",
		"project_id", projectID,
		"file_count", len(files),
	)

	// Delete all documents first
	if err := h.importService.DeleteAllDocuments(c.Context(), projectID); err != nil {
		h.logger.Error("failed to delete all documents",
			"project_id", projectID,
			"error", err,
		)
		return handleError(c, err)
	}

	h.logger.Info("deleted all documents",
		"project_id", projectID,
	)

	// Aggregate results across all files
	aggregatedResult := &docsysSvc.ImportResult{
		Summary:   docsysSvc.ImportSummary{},
		Errors:    []docsysSvc.ImportError{},
		Documents: []docsysSvc.ImportDocument{},
	}

	// Process each zip file (same as Merge)
	for _, fileHeader := range files {
		// Validate file is a zip
		if fileHeader.Header.Get("Content-Type") != "application/zip" &&
			fileHeader.Header.Get("Content-Type") != "application/x-zip-compressed" {
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: "file is not a zip file",
			})
			aggregatedResult.Summary.Failed++
			continue
		}

		// Open file
		file, err := fileHeader.Open()
		if err != nil {
			h.logger.Error("failed to open uploaded file",
				"file", fileHeader.Filename,
				"error", err,
			)
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: fmt.Sprintf("failed to open file: %v", err),
			})
			continue
		}

		// Process zip file
		result, err := h.importService.ProcessZipFile(c.Context(), projectID, userID, file)
		file.Close()

		if err != nil {
			h.logger.Error("failed to process zip file",
				"file", fileHeader.Filename,
				"error", err,
			)
			aggregatedResult.Errors = append(aggregatedResult.Errors, docsysSvc.ImportError{
				File:  fileHeader.Filename,
				Error: fmt.Sprintf("failed to process zip: %v", err),
			})
			continue
		}

		// Aggregate results
		aggregatedResult.Summary.Created += result.Summary.Created
		aggregatedResult.Summary.Updated += result.Summary.Updated
		aggregatedResult.Summary.Skipped += result.Summary.Skipped
		aggregatedResult.Summary.Failed += result.Summary.Failed
		aggregatedResult.Summary.TotalFiles += result.Summary.TotalFiles
		aggregatedResult.Errors = append(aggregatedResult.Errors, result.Errors...)
		aggregatedResult.Documents = append(aggregatedResult.Documents, result.Documents...)
	}

	h.logger.Info("replace import complete",
		"project_id", projectID,
		"created", aggregatedResult.Summary.Created,
		"updated", aggregatedResult.Summary.Updated,
		"failed", aggregatedResult.Summary.Failed,
	)

	// Build response
	response := ImportResponse{
		Success:   aggregatedResult.Summary.Failed == 0,
		Summary:   aggregatedResult.Summary,
		Errors:    aggregatedResult.Errors,
		Documents: aggregatedResult.Documents,
	}

	return c.Status(fiber.StatusOK).JSON(response)
}
