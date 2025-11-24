package docsystem

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/service/docsystem/converter"
)

// individualFileProcessor processes individual files (.md, .txt, .html)
type individualFileProcessor struct {
	docService        docsysSvc.DocumentService
	converterRegistry *converter.ConverterRegistry
	logger            *slog.Logger
}

// NewIndividualFileProcessor creates a new individual file processor
func NewIndividualFileProcessor(
	docService docsysSvc.DocumentService,
	converterRegistry *converter.ConverterRegistry,
	logger *slog.Logger,
) docsysSvc.FileProcessor {
	return &individualFileProcessor{
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
func (p *individualFileProcessor) Process(
	ctx context.Context,
	projectID string,
	userID string,
	file io.Reader,
	filename string,
	folderPath string,
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

	// Create document
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

// Name returns the processor name
func (p *individualFileProcessor) Name() string {
	return "IndividualFileProcessor"
}
