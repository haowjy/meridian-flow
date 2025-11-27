package docsystem

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	docsysModels "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/service/docsystem/converter"
)

// individualFileProcessor processes individual files (.md, .txt, .html)
type individualFileProcessor struct {
	docRepo           docsysRepo.DocumentRepository
	docService        docsysSvc.DocumentService
	converterRegistry *converter.ConverterRegistry
	logger            *slog.Logger
}

// NewIndividualFileProcessor creates a new individual file processor
func NewIndividualFileProcessor(
	docRepo docsysRepo.DocumentRepository,
	docService docsysSvc.DocumentService,
	converterRegistry *converter.ConverterRegistry,
	logger *slog.Logger,
) docsysSvc.FileProcessor {
	return &individualFileProcessor{
		docRepo:           docRepo,
		docService:        docService,
		converterRegistry: converterRegistry,
		logger:            logger,
	}
}

// CanProcess returns true if this processor can handle the file extension
func (p *individualFileProcessor) CanProcess(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	// Check if converter registry has a converter for this extension
	return p.converterRegistry.GetConverter(ext) != nil
}

// Process imports a single file as a document
// If overwrite is true, existing documents are updated; if false, duplicates are skipped
func (p *individualFileProcessor) Process(
	ctx context.Context,
	projectID string,
	userID string,
	file io.Reader,
	filename string,
	folderPath string,
	overwrite bool,
) (*docsysSvc.ImportResult, error) {
	// Initialize result
	result := &docsysSvc.ImportResult{
		Summary:   docsysSvc.ImportSummary{TotalFiles: 1},
		Errors:    []docsysSvc.ImportError{},
		Documents: []docsysSvc.ImportDocument{},
	}

	// Read file content
	content, err := io.ReadAll(file)
	if err != nil {
		result.Summary.Failed = 1
		result.Errors = append(result.Errors, docsysSvc.ImportError{
			File:  filename,
			Error: fmt.Sprintf("failed to read file: %v", err),
		})
		p.logger.Warn("failed to read file", "filename", filename, "error", err)
		return result, nil // Return result, not error (allows batch to continue)
	}

	// Convert to markdown
	markdown, err := p.converterRegistry.Convert(ctx, filename, content)
	if err != nil {
		result.Summary.Failed = 1
		result.Errors = append(result.Errors, docsysSvc.ImportError{
			File:  filename,
			Error: fmt.Sprintf("failed to convert file: %v", err),
		})
		p.logger.Warn("failed to convert file", "filename", filename, "error", err)
		return result, nil
	}

	// Extract document name (without extension)
	baseName := filepath.Base(filename)
	ext := filepath.Ext(baseName)
	docName := strings.TrimSuffix(baseName, ext)

	// Sanitize document name: replace slashes with hyphens
	docName = strings.ReplaceAll(docName, "/", "-")

	// Check for existing document with same name in target folder
	existingDoc, err := p.findExistingDocument(ctx, projectID, folderPath, docName)
	if err != nil {
		result.Summary.Failed = 1
		result.Errors = append(result.Errors, docsysSvc.ImportError{
			File:  filename,
			Error: fmt.Sprintf("failed to check for existing document: %v", err),
		})
		p.logger.Warn("failed to check for existing document", "filename", filename, "error", err)
		return result, nil
	}

	if existingDoc != nil {
		if overwrite {
			// Update existing document
			doc, err := p.docService.UpdateDocument(ctx, userID, existingDoc.ID, &docsysSvc.UpdateDocumentRequest{
				ProjectID: projectID,
				Content:   &markdown,
			})
			if err != nil {
				result.Summary.Failed = 1
				result.Errors = append(result.Errors, docsysSvc.ImportError{
					File:  filename,
					Error: fmt.Sprintf("failed to update document: %v", err),
				})
				p.logger.Warn("failed to update document", "filename", filename, "error", err)
				return result, nil
			}

			result.Summary.Updated = 1
			result.Documents = append(result.Documents, docsysSvc.ImportDocument{
				ID:     doc.ID,
				Path:   doc.Path,
				Name:   doc.Name,
				Action: "updated",
			})

			p.logger.Debug("individual file updated",
				"filename", filename,
				"doc_id", doc.ID,
				"folder_path", folderPath,
			)
		} else {
			// Skip duplicate
			fullPath := folderPath + "/" + docName
			if folderPath == "" {
				fullPath = docName
			}

			result.Summary.Skipped = 1
			result.Documents = append(result.Documents, docsysSvc.ImportDocument{
				ID:     existingDoc.ID,
				Path:   fullPath,
				Name:   docName,
				Action: "skipped",
			})

			p.logger.Debug("individual file skipped (duplicate)",
				"filename", filename,
				"folder_path", folderPath,
			)
		}
		return result, nil
	}

	// Create new document
	doc, err := p.docService.CreateDocument(ctx, &docsysSvc.CreateDocumentRequest{
		ProjectID:  projectID,
		UserID:     userID,
		FolderPath: &folderPath, // Use provided folder path (empty string = root)
		Name:       docName,
		Content:    markdown,
	})

	if err != nil {
		result.Summary.Failed = 1
		result.Errors = append(result.Errors, docsysSvc.ImportError{
			File:  filename,
			Error: fmt.Sprintf("failed to create document: %v", err),
		})
		p.logger.Warn("failed to create document", "filename", filename, "error", err)
		return result, nil
	}

	// Success
	result.Summary.Created = 1
	result.Documents = append(result.Documents, docsysSvc.ImportDocument{
		ID:     doc.ID,
		Path:   doc.Path,
		Name:   doc.Name,
		Action: "created",
	})

	p.logger.Debug("individual file imported",
		"filename", filename,
		"doc_id", doc.ID,
		"folder_path", folderPath,
	)

	return result, nil
}

// findExistingDocument checks if a document with the given name exists in the target folder
func (p *individualFileProcessor) findExistingDocument(
	ctx context.Context,
	projectID string,
	folderPath string,
	docName string,
) (*docsysModels.Document, error) {
	// Get all documents in project and find matching one
	docs, err := p.docRepo.GetAllMetadataByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Build target path for comparison
	targetPath := folderPath + "/" + docName
	if folderPath == "" {
		targetPath = docName
	}

	for _, doc := range docs {
		// Compute path for this document
		path, err := p.docRepo.GetPath(ctx, &doc)
		if err != nil {
			continue
		}

		// Check if path and name match
		key := fmt.Sprintf("%s|%s", path, doc.Name)
		targetKey := fmt.Sprintf("%s|%s", targetPath, docName)
		if key == targetKey {
			return &doc, nil
		}
	}

	return nil, nil
}

// Name returns the processor name
func (p *individualFileProcessor) Name() string {
	return "IndividualFileProcessor"
}
