package service

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"

	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
	"meridian/internal/utils"
)

// importService implements the ImportService interface
type importService struct {
	docRepo    repositories.DocumentRepository
	docService services.DocumentService
	logger     *slog.Logger
}

// NewImportService creates a new import service
func NewImportService(
	docRepo repositories.DocumentRepository,
	docService services.DocumentService,
	logger *slog.Logger,
) services.ImportService {
	return &importService{
		docRepo:    docRepo,
		docService: docService,
		logger:     logger,
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

// ProcessZipFile processes a zip file and imports documents
func (s *importService) ProcessZipFile(ctx context.Context, projectID string, zipReader io.Reader) (*services.ImportResult, error) {
	// Read zip file into memory
	zipData, err := io.ReadAll(zipReader)
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
	existingDocs, err := s.docRepo.GetAllMetadataByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get existing documents: %w", err)
	}

	// Build map of (path, name) -> document_id for quick lookup
	docMap := make(map[string]string) // key: "path|name", value: document_id
	for _, doc := range existingDocs {
		// Compute path for the document
		path, err := s.docRepo.GetPath(ctx, &doc)
		if err != nil {
			s.logger.Warn("failed to compute path for existing document",
				"doc_id", doc.ID,
				"error", err,
			)
			continue
		}
		key := fmt.Sprintf("%s|%s", path, doc.Name)
		docMap[key] = doc.ID
	}

	// Initialize result
	result := &services.ImportResult{
		Summary:   services.ImportSummary{},
		Errors:    []services.ImportError{},
		Documents: []services.ImportDocument{},
	}

	// Process each file in the zip
	for _, file := range zipFile.File {
		// Skip directories
		if file.FileInfo().IsDir() {
			continue
		}

		// Skip non-markdown files
		if filepath.Ext(file.Name) != ".md" {
			s.logger.Debug("skipping non-markdown file", "file", file.Name)
			result.Summary.Skipped++
			result.Summary.TotalFiles++
			continue
		}

		// Process markdown file
		s.processMarkdownFile(ctx, projectID, file, docMap, result)
	}

	s.logger.Info("zip file processing complete",
		"project_id", projectID,
		"created", result.Summary.Created,
		"updated", result.Summary.Updated,
		"skipped", result.Summary.Skipped,
		"failed", result.Summary.Failed,
		"total_files", result.Summary.TotalFiles,
	)

	return result, nil
}

// processMarkdownFile processes a single markdown file from the zip
func (s *importService) processMarkdownFile(
	ctx context.Context,
	projectID string,
	file *zip.File,
	docMap map[string]string,
	result *services.ImportResult,
) {
	result.Summary.TotalFiles++

	// Open file
	fileReader, err := file.Open()
	if err != nil {
		s.addError(result, file.Name, fmt.Sprintf("failed to open file: %v", err))
		return
	}
	defer fileReader.Close()

	// Read file content
	fileContent, err := io.ReadAll(fileReader)
	if err != nil {
		s.addError(result, file.Name, fmt.Sprintf("failed to read file: %v", err))
		return
	}

	// Parse frontmatter (optional)
	metadata, markdown, err := utils.ParseFrontmatter(fileContent)
	var docMeta *utils.DocumentMetadata

	if err != nil {
		// No frontmatter - derive everything from filepath
		markdown = string(fileContent)
		docMeta = &utils.DocumentMetadata{}
	} else {
		// Validate metadata
		docMeta, err = utils.ValidateImportMetadata(metadata)
		if err != nil {
			s.addError(result, file.Name, fmt.Sprintf("invalid frontmatter: %v", err))
			return
		}
	}

	// Determine folder path and document name
	var folderPath string
	var docName string

	if docMeta.Path != nil {
		// Use path from frontmatter as folder path
		folderPath = *docMeta.Path
	} else {
		// Derive folder path from directory structure in zip
		// Example: "Characters/Aria.md" -> folderPath="Characters"
		// Example: "Characters/Villains/Shadow.md" -> folderPath="Characters/Villains"
		// Example: "root.md" -> folderPath=""
		dirPath := filepath.Dir(file.Name)
		if dirPath == "." {
			// File is at root of zip
			folderPath = ""
		} else {
			folderPath = dirPath
		}
	}

	if docMeta.Name != nil {
		// Use name from frontmatter (allows "/" in names)
		docName = *docMeta.Name
	} else {
		// Use filename without extension as document name
		docName = strings.TrimSuffix(filepath.Base(file.Name), ".md")
	}

	// Construct full path for document lookup
	// This must match how GetPath() constructs paths for existing documents
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
		// Update existing document
		s.updateDocument(ctx, projectID, existingDocID, markdown, result)
	} else {
		// Create new document
		s.createDocument(ctx, projectID, folderPath, docName, markdown, result)
	}
}

// createDocument creates a new document
func (s *importService) createDocument(
	ctx context.Context,
	projectID string,
	folderPath string,
	docName string,
	content string,
	result *services.ImportResult,
) {
	// Create document via service
	// Always pass FolderPath as a pointer (empty string for root level)
	doc, err := s.docService.CreateDocument(ctx, &services.CreateDocumentRequest{
		ProjectID:  projectID,
		FolderPath: &folderPath, // Always pass pointer, empty string is valid for root
		Name:       docName,
		Content:    content,
	})

	if err != nil {
		fullPath := folderPath + "/" + docName
		if folderPath == "" {
			fullPath = docName
		}
		s.addError(result, fullPath, fmt.Sprintf("failed to create document: %v", err))
		return
	}

	// Add to result
	result.Summary.Created++
	result.Documents = append(result.Documents, services.ImportDocument{
		ID:     doc.ID,
		Path:   doc.Path,
		Name:   doc.Name,
		Action: "created",
	})

	s.logger.Debug("document created",
		"id", doc.ID,
		"folder_path", folderPath,
		"name", docName,
	)
}

// updateDocument updates an existing document
func (s *importService) updateDocument(
	ctx context.Context,
	projectID string,
	docID string,
	content string,
	result *services.ImportResult,
) {
	// Update document via service
	doc, err := s.docService.UpdateDocument(ctx, docID, &services.UpdateDocumentRequest{
		ProjectID: projectID,
		Content:   &content,
	})

	if err != nil {
		s.addError(result, doc.Path, fmt.Sprintf("failed to update document: %v", err))
		return
	}

	// Add to result
	result.Summary.Updated++
	result.Documents = append(result.Documents, services.ImportDocument{
		ID:     doc.ID,
		Path:   doc.Path,
		Name:   doc.Name,
		Action: "updated",
	})

	s.logger.Debug("document updated",
		"id", doc.ID,
		"path", doc.Path,
	)
}

// addError adds an error to the result
func (s *importService) addError(result *services.ImportResult, file string, errorMsg string) {
	result.Summary.Failed++
	result.Errors = append(result.Errors, services.ImportError{
		File:  file,
		Error: errorMsg,
	})

	s.logger.Warn("file processing failed",
		"file", file,
		"error", errorMsg,
	)
}
