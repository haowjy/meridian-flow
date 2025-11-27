package docsystem

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/service/docsystem/converter"
)

// zipFileProcessor processes zip files and imports their contents
type zipFileProcessor struct {
	docRepo           docsysRepo.DocumentRepository
	docService        docsysSvc.DocumentService
	converterRegistry *converter.ConverterRegistry
	logger            *slog.Logger
}

// NewZipFileProcessor creates a new zip file processor
func NewZipFileProcessor(
	docRepo docsysRepo.DocumentRepository,
	docService docsysSvc.DocumentService,
	converterRegistry *converter.ConverterRegistry,
	logger *slog.Logger,
) docsysSvc.FileProcessor {
	return &zipFileProcessor{
		docRepo:           docRepo,
		docService:        docService,
		converterRegistry: converterRegistry,
		logger:            logger,
	}
}

// CanProcess returns true for .zip files
func (p *zipFileProcessor) CanProcess(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	return ext == ".zip"
}

// Process extracts and imports documents from a zip file
// If overwrite is true, existing documents are updated; if false, duplicates are skipped
func (p *zipFileProcessor) Process(
	ctx context.Context,
	projectID string,
	userID string,
	file io.Reader,
	filename string,
	folderPath string,
	overwrite bool,
) (*docsysSvc.ImportResult, error) {
	// Read zip file into memory
	zipData, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("failed to read zip file: %w", err)
	}

	// Open zip reader
	zipReaderAt := bytes.NewReader(zipData)
	zipFile, err := zip.NewReader(zipReaderAt, int64(len(zipData)))
	if err != nil {
		return nil, fmt.Errorf("failed to open zip file: %w", err)
	}

	// Get all existing documents in project to check for updates
	existingDocs, err := p.docRepo.GetAllMetadataByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get existing documents: %w", err)
	}

	// Build map of (path, name) -> document_id for quick lookup
	docMap := make(map[string]string) // key: "path|name", value: document_id
	for _, doc := range existingDocs {
		// Compute path for the document
		path, err := p.docRepo.GetPath(ctx, &doc)
		if err != nil {
			p.logger.Warn("failed to compute path for existing document",
				"doc_id", doc.ID,
				"error", err,
			)
			continue
		}
		key := fmt.Sprintf("%s|%s", path, doc.Name)
		docMap[key] = doc.ID
	}

	// Initialize result
	result := &docsysSvc.ImportResult{
		Summary:   docsysSvc.ImportSummary{},
		Errors:    []docsysSvc.ImportError{},
		Documents: []docsysSvc.ImportDocument{},
	}

	// Process each file in the zip
	for _, zipEntry := range zipFile.File {
		// Skip directories
		if zipEntry.FileInfo().IsDir() {
			continue
		}

		// Check if file extension is supported
		ext := filepath.Ext(zipEntry.Name)
		if p.converterRegistry.GetConverter(ext) == nil {
			p.logger.Debug("skipping unsupported file type", "file", zipEntry.Name, "ext", ext)
			result.Summary.Skipped++
			result.Summary.TotalFiles++
			continue
		}

		// Process file from zip
		p.processZipEntry(ctx, projectID, userID, zipEntry, docMap, overwrite, result)
	}

	p.logger.Info("zip file processing complete",
		"filename", filename,
		"project_id", projectID,
		"created", result.Summary.Created,
		"updated", result.Summary.Updated,
		"skipped", result.Summary.Skipped,
		"failed", result.Summary.Failed,
		"total_files", result.Summary.TotalFiles,
	)

	return result, nil
}

// Name returns the processor name
func (p *zipFileProcessor) Name() string {
	return "ZipFileProcessor"
}

// processZipEntry processes a single file from the zip archive
func (p *zipFileProcessor) processZipEntry(
	ctx context.Context,
	projectID string,
	userID string,
	file *zip.File,
	docMap map[string]string,
	overwrite bool,
	result *docsysSvc.ImportResult,
) {
	result.Summary.TotalFiles++

	// Open file
	fileReader, err := file.Open()
	if err != nil {
		p.addError(result, file.Name, fmt.Sprintf("failed to open file: %v", err))
		return
	}
	defer fileReader.Close()

	// Read file content
	fileContent, err := io.ReadAll(fileReader)
	if err != nil {
		p.addError(result, file.Name, fmt.Sprintf("failed to read file: %v", err))
		return
	}

	// Convert content to markdown using appropriate converter
	markdown, err := p.converterRegistry.Convert(ctx, file.Name, fileContent)
	if err != nil {
		p.addError(result, file.Name, fmt.Sprintf("failed to convert file: %v", err))
		return
	}

	// Determine folder path and document name
	var folderPath string
	var docName string

	// Derive folder path from directory structure in zip
	dirPath := filepath.Dir(file.Name)
	if dirPath == "." {
		// File is at root of zip
		folderPath = ""
	} else {
		folderPath = dirPath
	}

	// Use filename without extension as document name
	baseName := filepath.Base(file.Name)
	ext := filepath.Ext(baseName)
	docName = strings.TrimSuffix(baseName, ext)

	// Sanitize document name: replace slashes with hyphens
	docName = strings.ReplaceAll(docName, "/", "-")

	// Construct full path for document lookup
	fullPath := folderPath
	if docName != "" && folderPath != "" {
		fullPath = folderPath + "/" + docName
	} else if docName != "" {
		fullPath = docName
	}

	// Check if document exists
	lookupKey := fmt.Sprintf("%s|%s", fullPath, docName)
	existingDocID, exists := docMap[lookupKey]

	if exists {
		if overwrite {
			// Update existing document
			p.updateDocument(ctx, projectID, userID, existingDocID, markdown, result)
		} else {
			// Skip duplicate - don't overwrite
			p.skipDocument(result, folderPath, docName)
		}
	} else {
		// Create new document
		p.createDocument(ctx, projectID, userID, folderPath, docName, markdown, result)
	}
}

// createDocument creates a new document
func (p *zipFileProcessor) createDocument(
	ctx context.Context,
	projectID string,
	userID string,
	folderPath string,
	docName string,
	content string,
	result *docsysSvc.ImportResult,
) {
	doc, err := p.docService.CreateDocument(ctx, &docsysSvc.CreateDocumentRequest{
		ProjectID:  projectID,
		UserID:     userID,
		FolderPath: &folderPath,
		Name:       docName,
		Content:    content,
	})

	if err != nil {
		fullPath := folderPath + "/" + docName
		if folderPath == "" {
			fullPath = docName
		}
		p.addError(result, fullPath, fmt.Sprintf("failed to create document: %v", err))
		return
	}

	result.Summary.Created++
	result.Documents = append(result.Documents, docsysSvc.ImportDocument{
		ID:     doc.ID,
		Path:   doc.Path,
		Name:   doc.Name,
		Action: "created",
	})

	p.logger.Debug("document created",
		"id", doc.ID,
		"folder_path", folderPath,
		"name", docName,
	)
}

// updateDocument updates an existing document
func (p *zipFileProcessor) updateDocument(
	ctx context.Context,
	projectID string,
	userID string,
	docID string,
	content string,
	result *docsysSvc.ImportResult,
) {
	doc, err := p.docService.UpdateDocument(ctx, userID, docID, &docsysSvc.UpdateDocumentRequest{
		ProjectID: projectID,
		Content:   &content,
	})

	if err != nil {
		p.addError(result, docID, fmt.Sprintf("failed to update document: %v", err))
		return
	}

	result.Summary.Updated++
	result.Documents = append(result.Documents, docsysSvc.ImportDocument{
		ID:     doc.ID,
		Path:   doc.Path,
		Name:   doc.Name,
		Action: "updated",
	})

	p.logger.Debug("document updated",
		"id", doc.ID,
		"path", doc.Path,
	)
}

// skipDocument records a skipped duplicate document
func (p *zipFileProcessor) skipDocument(
	result *docsysSvc.ImportResult,
	folderPath string,
	docName string,
) {
	fullPath := folderPath + "/" + docName
	if folderPath == "" {
		fullPath = docName
	}

	result.Summary.Skipped++
	result.Documents = append(result.Documents, docsysSvc.ImportDocument{
		ID:     "", // No ID for skipped documents
		Path:   fullPath,
		Name:   docName,
		Action: "skipped",
	})

	p.logger.Debug("document skipped (duplicate)",
		"folder_path", folderPath,
		"name", docName,
	)
}

// addError adds an error to the result
func (p *zipFileProcessor) addError(result *docsysSvc.ImportResult, file string, errorMsg string) {
	result.Summary.Failed++
	result.Errors = append(result.Errors, docsysSvc.ImportError{
		File:  file,
		Error: errorMsg,
	})

	p.logger.Warn("file processing failed",
		"file", file,
		"error", errorMsg,
	)
}
