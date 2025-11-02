package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"meridian/internal/config"
	"meridian/internal/domain"
	"meridian/internal/domain/models"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
)

// documentService implements the DocumentService interface
type documentService struct {
	docRepo    repositories.DocumentRepository
	folderRepo repositories.FolderRepository
	txManager  repositories.TransactionManager
	logger     *slog.Logger
}

// NewDocumentService creates a new document service
func NewDocumentService(
	docRepo repositories.DocumentRepository,
	folderRepo repositories.FolderRepository,
	txManager repositories.TransactionManager,
	logger *slog.Logger,
) services.DocumentService {
	return &documentService{
		docRepo:    docRepo,
		folderRepo: folderRepo,
		txManager:  txManager,
		logger:     logger,
	}
}

// CreateDocument creates a new document with priority-based folder resolution
func (s *documentService) CreateDocument(ctx context.Context, req *services.CreateDocumentRequest) (*models.Document, error) {
	// Validate request
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Normalize empty string folder_id to nil for root-level documents (consistent with UPDATE)
	// Note: folder_path already handles empty string in resolveFolderPath
	if req.FolderID != nil && *req.FolderID == "" {
		req.FolderID = nil
	}

	var folderID *string
	docName := req.Name

	// Priority-based folder resolution:
	// 1. Try folder_id first (frontend optimization - direct lookup)
	// 2. Fall back to folder_path (external AI / import - resolve/auto-create)
	if req.FolderID != nil {
		// Frontend optimization: use provided folder_id directly
		folderID = req.FolderID
	} else if req.FolderPath != nil {
		// External AI / Import: resolve folder path, creating folders if needed
		resolvedFolder, err := s.resolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
		}
		folderID = resolvedFolder
	} else {
		// Should never reach here due to validation, but defensive check
		return nil, fmt.Errorf("%w: either folder_path or folder_id must be provided", domain.ErrValidation)
	}

	// Count words (business logic)
	wordCount := s.countWords(req.Content)

	// Create document
	doc := &models.Document{
		ProjectID: req.ProjectID,
		FolderID:  folderID,
		Name:      docName,
		Content:   req.Content,
		WordCount: wordCount,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.docRepo.Create(ctx, doc); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = docName
	} else {
		doc.Path = path
	}

	s.logger.Info("document created",
		"id", doc.ID,
		"name", doc.Name,
		"project_id", req.ProjectID,
		"folder_id", folderID,
		"word_count", wordCount,
	)

	return doc, nil
}

// GetDocument retrieves a document with its computed path
func (s *documentService) GetDocument(ctx context.Context, id, projectID string) (*models.Document, error) {
	doc, err := s.docRepo.GetByID(ctx, id, projectID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	return doc, nil
}

// UpdateDocument updates a document
func (s *documentService) UpdateDocument(ctx context.Context, id string, req *services.UpdateDocumentRequest) (*models.Document, error) {
	// Get existing document
	doc, err := s.docRepo.GetByID(ctx, id, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		doc.Name = *req.Name
	}

	// Priority-based folder resolution for moving documents:
	// 1. Try folder_id first (frontend optimization - direct lookup)
	// 2. Fall back to folder_path (external AI - resolve/auto-create)
	// 3. Neither = don't move document
	if req.FolderID != nil {
		// Frontend optimization: use provided folder_id directly
		doc.FolderID = req.FolderID
	} else if req.FolderPath != nil {
		// External AI: resolve folder path, creating folders if needed
		resolvedFolder, err := s.resolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
		}
		doc.FolderID = resolvedFolder
	}
	// If neither provided: keep current folder location

	if req.Content != nil {
		doc.Content = *req.Content
		// Recalculate word count
		doc.WordCount = s.countWords(doc.Content)
	}

	doc.UpdatedAt = time.Now()

	// Update in database
	if err := s.docRepo.Update(ctx, doc); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	s.logger.Info("document updated",
		"id", doc.ID,
		"name", doc.Name,
		"project_id", req.ProjectID,
	)

	return doc, nil
}

// DeleteDocument deletes a document
func (s *documentService) DeleteDocument(ctx context.Context, id, projectID string) error {
	if err := s.docRepo.Delete(ctx, id, projectID); err != nil {
		return err
	}

	s.logger.Info("document deleted",
		"id", id,
		"project_id", projectID,
	)

	return nil
}

// validateCreateRequest validates a document creation request
func (s *documentService) validateCreateRequest(req *services.CreateDocumentRequest) error {
	// Require at least one of FolderPath or FolderID
	if req.FolderPath == nil && req.FolderID == nil {
		return fmt.Errorf("either folder_path or folder_id must be provided")
	}

	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.FolderPath,
			validation.Length(0, config.MaxDocumentPathLength), // 0-length allowed for root level
			validation.By(s.validateFolderPath),
		),
		validation.Field(&req.Name,
			validation.Required,
			validation.Length(1, config.MaxDocumentNameLength),
		),
		validation.Field(&req.Content, validation.Required),
	)
}

// validateFolderPath validates a folder path
func (s *documentService) validateFolderPath(value interface{}) error {
	path, ok := value.(*string)
	if !ok || path == nil {
		return nil
	}

	pathStr := *path

	// Empty string is valid (root level)
	if pathStr == "" {
		return nil
	}

	// No leading/trailing slashes
	if strings.HasPrefix(pathStr, "/") || strings.HasSuffix(pathStr, "/") {
		return fmt.Errorf("folder_path cannot start or end with '/'")
	}

	// No consecutive slashes
	if strings.Contains(pathStr, "//") {
		return fmt.Errorf("folder_path cannot contain consecutive slashes")
	}

	// Only alphanumeric, spaces, hyphens, underscores, slashes
	for _, char := range pathStr {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
			char != ' ' && char != '-' && char != '_' && char != '/' {
			return fmt.Errorf("folder_path contains invalid character: %c", char)
		}
	}

	return nil
}

// resolveFolderPath resolves a folder path to a folder ID, creating folders if needed
func (s *documentService) resolveFolderPath(ctx context.Context, projectID, folderPath string) (*string, error) {
	// Trim leading/trailing slashes
	folderPath = strings.Trim(folderPath, "/")

	// Empty path means root level
	if folderPath == "" {
		return nil, nil
	}

	// Split path into folder segments
	segments := strings.Split(folderPath, "/")
	if len(segments) == 0 {
		return nil, fmt.Errorf("invalid folder_path")
	}

	// Create all folders in the hierarchy
	folderID, err := s.createFolderHierarchy(ctx, projectID, segments)
	if err != nil {
		return nil, err
	}

	return folderID, nil
}

// createFolderHierarchy creates a hierarchy of folders, creating them if they don't exist
func (s *documentService) createFolderHierarchy(ctx context.Context, projectID string, segments []string) (*string, error) {
	var currentParentID *string // Start at root

	for _, segment := range segments {
		// Validate folder name
		if len(segment) > config.MaxFolderNameLength {
			return nil, fmt.Errorf("folder name '%s' exceeds maximum length of %d", segment, config.MaxFolderNameLength)
		}

		// Create folder if it doesn't exist
		folder, err := s.folderRepo.CreateIfNotExists(ctx, projectID, currentParentID, segment)
		if err != nil {
			return nil, fmt.Errorf("failed to create/get folder '%s': %w", segment, err)
		}

		// Move to next level
		currentParentID = &folder.ID
	}

	return currentParentID, nil
}

// countWords counts the number of words in markdown text
func (s *documentService) countWords(markdown string) int {
	// Remove markdown syntax for more accurate word count
	text := s.cleanMarkdown(markdown)

	// Split by whitespace and count non-empty tokens
	words := strings.FieldsFunc(text, func(r rune) bool {
		return unicode.IsSpace(r)
	})

	// Filter out empty strings
	count := 0
	for _, word := range words {
		if len(strings.TrimSpace(word)) > 0 {
			count++
		}
	}

	return count
}

func (s *documentService) cleanMarkdown(markdown string) string {
	text := markdown

	// Remove code blocks
	text = s.removeCodeBlocks(text)

	// Remove inline code
	text = strings.ReplaceAll(text, "`", "")

	// Remove bold and italic markers
	text = strings.ReplaceAll(text, "**", "")
	text = strings.ReplaceAll(text, "*", "")
	text = strings.ReplaceAll(text, "__", "")
	text = strings.ReplaceAll(text, "_", "")
	text = strings.ReplaceAll(text, "~~", "")

	// Remove heading markers
	text = strings.ReplaceAll(text, "#", "")

	// Remove list markers
	lines := strings.Split(text, "\n")
	var cleanedLines []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "- ") {
			line = strings.TrimPrefix(line, "- ")
		} else if strings.HasPrefix(line, "* ") {
			line = strings.TrimPrefix(line, "* ")
		}
		if len(line) > 2 && unicode.IsDigit(rune(line[0])) && line[1] == '.' {
			line = line[2:]
		}
		cleanedLines = append(cleanedLines, line)
	}
	text = strings.Join(cleanedLines, " ")

	// Remove blockquote markers
	text = strings.ReplaceAll(text, ">", "")

	// Remove horizontal rules
	text = strings.ReplaceAll(text, "---", "")
	text = strings.ReplaceAll(text, "***", "")

	return text
}

func (s *documentService) removeCodeBlocks(text string) string {
	for {
		start := strings.Index(text, "```")
		if start == -1 {
			break
		}
		end := strings.Index(text[start+3:], "```")
		if end == -1 {
			break
		}
		text = text[:start] + text[start+end+6:]
	}
	return text
}
