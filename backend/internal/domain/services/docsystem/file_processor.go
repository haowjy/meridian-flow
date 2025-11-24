package docsystem

import (
	"context"
	"io"
)

// FileProcessor defines the strategy interface for processing uploaded files.
// Different implementations handle different file types (zip, individual files, etc.)
type FileProcessor interface {
	// CanProcess returns true if this processor can handle the given filename
	CanProcess(filename string) bool

	// Process handles file upload and returns import results
	Process(
		ctx context.Context,
		projectID string,
		userID string,
		file io.Reader,
		filename string,
		folderPath string,
	) (*ImportResult, error)

	// Name returns the processor name for logging
	Name() string
}
