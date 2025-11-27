package docsystem

import (
	"context"
)

// ImportService handles bulk document import operations
type ImportService interface {
	// DeleteAllDocuments deletes all documents in a project
	DeleteAllDocuments(ctx context.Context, projectID string) error

	// ProcessFiles processes uploaded files (zip or individual files) and imports documents
	// Uses file processor strategies to handle different file types
	// If overwrite is true, existing documents are updated; if false, duplicates are skipped
	// Returns detailed results including created/updated/skipped/failed counts
	ProcessFiles(ctx context.Context, projectID, userID string, files []UploadedFile, folderPath string, overwrite bool) (*ImportResult, error)
}

// ImportResult represents the result of a bulk import operation
type ImportResult struct {
	Summary   ImportSummary    `json:"summary"`
	Errors    []ImportError    `json:"errors"`
	Documents []ImportDocument `json:"documents"`
}

// ImportSummary contains aggregate statistics for an import operation
type ImportSummary struct {
	Created    int `json:"created"`
	Updated    int `json:"updated"`
	Skipped    int `json:"skipped"`
	Failed     int `json:"failed"`
	TotalFiles int `json:"total_files"`
}

// ImportError represents an error that occurred during import
type ImportError struct {
	File  string `json:"file"`
	Error string `json:"error"`
}

// ImportDocument represents a processed document
type ImportDocument struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Name   string `json:"name"`
	Action string `json:"action"` // "created", "updated", or "skipped"
}
