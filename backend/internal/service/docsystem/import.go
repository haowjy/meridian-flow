package docsystem

import (
	"context"
	"fmt"
	"log/slog"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// importService implements the ImportService interface
type importService struct {
	docRepo               docsysRepo.DocumentRepository
	fileProcessorRegistry *FileProcessorRegistry
	logger                *slog.Logger
}

// NewImportService creates a new import service
func NewImportService(
	docRepo docsysRepo.DocumentRepository,
	fileProcessorRegistry *FileProcessorRegistry,
	logger *slog.Logger,
) docsysSvc.ImportService {
	return &importService{
		docRepo:               docRepo,
		fileProcessorRegistry: fileProcessorRegistry,
		logger:                logger,
	}
}

// DeleteAllDocuments deletes all documents in a project
func (s *importService) DeleteAllDocuments(ctx context.Context, projectID string) error {
	if err := s.docRepo.DeleteAllByProject(ctx, projectID); err != nil {
		s.logger.Error("failed to delete all documents",
			"project_id", projectID,
			"error", err,
		)
		return fmt.Errorf("failed to delete all documents: %w", err)
	}

	s.logger.Info("deleted all documents",
		"project_id", projectID,
	)

	return nil
}

// ProcessFiles processes uploaded files using file processor strategies
func (s *importService) ProcessFiles(ctx context.Context, projectID, userID string, files []docsysSvc.UploadedFile, folderPath string) (*docsysSvc.ImportResult, error) {
	// Initialize aggregated result
	aggregatedResult := &docsysSvc.ImportResult{
		Summary:   docsysSvc.ImportSummary{},
		Errors:    []docsysSvc.ImportError{},
		Documents: []docsysSvc.ImportDocument{},
	}

	// Process each file using appropriate processor
	for _, file := range files {
		processor := s.fileProcessorRegistry.GetProcessor(file.Filename)
		if processor == nil {
			s.logger.Debug("no processor for file", "filename", file.Filename)
			aggregatedResult.Summary.Skipped++
			aggregatedResult.Summary.TotalFiles++
			continue
		}

		// Process file with matched processor
		result, err := processor.Process(ctx, projectID, userID, file.Content, file.Filename, folderPath)
		if err != nil {
			return nil, fmt.Errorf("processor %s failed for file %s: %w", processor.Name(), file.Filename, err)
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

	s.logger.Info("file processing complete",
		"project_id", projectID,
		"created", aggregatedResult.Summary.Created,
		"updated", aggregatedResult.Summary.Updated,
		"skipped", aggregatedResult.Summary.Skipped,
		"failed", aggregatedResult.Summary.Failed,
		"total_files", aggregatedResult.Summary.TotalFiles,
	)

	return aggregatedResult, nil
}
