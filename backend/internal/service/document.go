package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"github.com/jimmyyao/meridian/backend/internal/config"
	"github.com/jimmyyao/meridian/backend/internal/domain"
	"github.com/jimmyyao/meridian/backend/internal/domain/models"
	"github.com/jimmyyao/meridian/backend/internal/domain/repositories"
	"github.com/jimmyyao/meridian/backend/internal/domain/services"
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

// CreateDocument creates a new document, resolving path to folders
func (s *documentService) CreateDocument(ctx context.Context, req *services.CreateDocumentRequest) (*models.Document, error) {
	// Validate request
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	var folderID *string
	var docName string

	// Path-based creation: resolve folders
	if req.Path != nil && *req.Path != "" {
		resolvedFolder, name, err := s.resolvePath(ctx, req.ProjectID, *req.Path)
		if err != nil {
			return nil, err
		}
		folderID = resolvedFolder
		docName = name
	} else {
		folderID = req.FolderID
		docName = *req.Name
	}

	// Convert TipTap to Markdown (business logic)
	markdown, err := s.convertTipTapToMarkdown(req.ContentTipTap)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to convert TipTap to markdown", domain.ErrValidation)
	}

	// Count words (business logic)
	wordCount := s.countWords(markdown)

	// Create document
	doc := &models.Document{
		ProjectID:       req.ProjectID,
		FolderID:        folderID,
		Name:            docName,
		ContentTipTap:   req.ContentTipTap,
		ContentMarkdown: markdown,
		WordCount:       wordCount,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
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
	if req.FolderID != nil {
		doc.FolderID = req.FolderID
	}
	if req.ContentTipTap != nil {
		doc.ContentTipTap = *req.ContentTipTap

		// Regenerate markdown and word count
		markdown, err := s.convertTipTapToMarkdown(doc.ContentTipTap)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to convert TipTap to markdown", domain.ErrValidation)
		}
		doc.ContentMarkdown = markdown
		doc.WordCount = s.countWords(markdown)
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
	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.Path,
			validation.When(req.FolderID == nil && req.Name == nil, validation.Required).Else(validation.Nil),
			validation.Length(1, config.MaxDocumentPathLength),
			validation.By(s.validatePath),
		),
		validation.Field(&req.Name,
			validation.When(req.Path == nil, validation.Required).Else(validation.Nil),
			validation.Length(1, config.MaxDocumentNameLength),
		),
		validation.Field(&req.ContentTipTap, validation.Required),
	)
}

// validatePath validates a document path
func (s *documentService) validatePath(value interface{}) error {
	path, ok := value.(*string)
	if !ok || path == nil {
		return nil
	}

	pathStr := *path

	// No leading/trailing slashes
	if strings.HasPrefix(pathStr, "/") || strings.HasSuffix(pathStr, "/") {
		return fmt.Errorf("path cannot start or end with '/'")
	}

	// No consecutive slashes
	if strings.Contains(pathStr, "//") {
		return fmt.Errorf("path cannot contain consecutive slashes")
	}

	// Only alphanumeric, spaces, hyphens, underscores, slashes
	for _, char := range pathStr {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
			char != ' ' && char != '-' && char != '_' && char != '/' {
			return fmt.Errorf("path contains invalid character: %c", char)
		}
	}

	return nil
}

// resolvePath resolves a path to a folder ID, creating folders if needed
func (s *documentService) resolvePath(ctx context.Context, projectID, path string) (*string, string, error) {
	// Trim leading/trailing slashes
	path = strings.Trim(path, "/")
	if path == "" {
		return nil, "", fmt.Errorf("path cannot be empty")
	}

	// Split path into segments
	segments := strings.Split(path, "/")
	if len(segments) == 0 {
		return nil, "", fmt.Errorf("invalid path")
	}

	// Last segment is the document name
	docName := segments[len(segments)-1]

	// If there's only one segment, it's a root-level document
	if len(segments) == 1 {
		return nil, docName, nil
	}

	// Create folders for all segments except the last one
	folderSegments := segments[:len(segments)-1]
	folderID, err := s.createFolderHierarchy(ctx, projectID, folderSegments)
	if err != nil {
		return nil, "", err
	}

	return folderID, docName, nil
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

// convertTipTapToMarkdown converts TipTap JSON to Markdown
func (s *documentService) convertTipTapToMarkdown(tiptapJSON map[string]interface{}) (string, error) {
	if tiptapJSON == nil {
		return "", nil
	}

	content, ok := tiptapJSON["content"].([]interface{})
	if !ok {
		return "", nil
	}

	var markdown strings.Builder
	for _, node := range content {
		nodeMap, ok := node.(map[string]interface{})
		if !ok {
			continue
		}
		s.convertNode(&markdown, nodeMap, 0)
	}

	return strings.TrimSpace(markdown.String()), nil
}

// convertNode converts a TipTap node to markdown (recursive)
func (s *documentService) convertNode(builder *strings.Builder, node map[string]interface{}, level int) {
	nodeType, _ := node["type"].(string)

	switch nodeType {
	case "heading":
		s.convertHeading(builder, node)
	case "paragraph":
		s.convertParagraph(builder, node)
	case "bulletList":
		s.convertBulletList(builder, node)
	case "orderedList":
		s.convertOrderedList(builder, node)
	case "listItem":
		s.convertListItem(builder, node, level)
	case "codeBlock":
		s.convertCodeBlock(builder, node)
	case "blockquote":
		s.convertBlockquote(builder, node)
	case "horizontalRule":
		builder.WriteString("---\n\n")
	case "hardBreak":
		builder.WriteString("  \n")
	default:
		// For unknown types, try to process content
		if content, ok := node["content"].([]interface{}); ok {
			for _, child := range content {
				if childNode, ok := child.(map[string]interface{}); ok {
					s.convertNode(builder, childNode, level)
				}
			}
		}
	}
}

func (s *documentService) convertHeading(builder *strings.Builder, node map[string]interface{}) {
	attrs, _ := node["attrs"].(map[string]interface{})
	level, _ := attrs["level"].(float64)

	for i := 0; i < int(level); i++ {
		builder.WriteString("#")
	}
	builder.WriteString(" ")

	if content, ok := node["content"].([]interface{}); ok {
		s.processInlineContent(builder, content)
	}
	builder.WriteString("\n\n")
}

func (s *documentService) convertParagraph(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		s.processInlineContent(builder, content)
	}
	builder.WriteString("\n\n")
}

func (s *documentService) convertBulletList(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, item := range content {
			if itemNode, ok := item.(map[string]interface{}); ok {
				builder.WriteString("- ")
				s.convertListItem(builder, itemNode, 0)
			}
		}
	}
	builder.WriteString("\n")
}

func (s *documentService) convertOrderedList(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for i, item := range content {
			if itemNode, ok := item.(map[string]interface{}); ok {
				builder.WriteString(fmt.Sprintf("%d. ", i+1))
				s.convertListItem(builder, itemNode, 0)
			}
		}
	}
	builder.WriteString("\n")
}

func (s *documentService) convertListItem(builder *strings.Builder, node map[string]interface{}, level int) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				childType, _ := childNode["type"].(string)
				if childType == "paragraph" {
					if childContent, ok := childNode["content"].([]interface{}); ok {
						s.processInlineContent(builder, childContent)
					}
					builder.WriteString("\n")
				} else {
					s.convertNode(builder, childNode, level+1)
				}
			}
		}
	}
}

func (s *documentService) convertCodeBlock(builder *strings.Builder, node map[string]interface{}) {
	attrs, _ := node["attrs"].(map[string]interface{})
	language, _ := attrs["language"].(string)

	builder.WriteString("```")
	if language != "" {
		builder.WriteString(language)
	}
	builder.WriteString("\n")

	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				if text, ok := childNode["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
	}

	builder.WriteString("\n```\n\n")
}

func (s *documentService) convertBlockquote(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				builder.WriteString("> ")
				s.convertNode(builder, childNode, 0)
			}
		}
	}
}

func (s *documentService) processInlineContent(builder *strings.Builder, content []interface{}) {
	for _, item := range content {
		node, ok := item.(map[string]interface{})
		if !ok {
			continue
		}

		nodeType, _ := node["type"].(string)
		if nodeType == "text" {
			text, _ := node["text"].(string)

			// Apply marks (bold, italic, code, etc.)
			if marks, ok := node["marks"].([]interface{}); ok {
				text = s.applyMarks(text, marks)
			}

			builder.WriteString(text)
		} else if nodeType == "hardBreak" {
			builder.WriteString("  \n")
		}
	}
}

func (s *documentService) applyMarks(text string, marks []interface{}) string {
	result := text
	var wrappers []string

	for _, mark := range marks {
		markMap, ok := mark.(map[string]interface{})
		if !ok {
			continue
		}

		markType, _ := markMap["type"].(string)
		switch markType {
		case "bold":
			wrappers = append([]string{"**"}, wrappers...)
		case "italic":
			wrappers = append([]string{"*"}, wrappers...)
		case "code":
			wrappers = append([]string{"`"}, wrappers...)
		case "strike":
			wrappers = append([]string{"~~"}, wrappers...)
		}
	}

	// Wrap text with all marks
	for _, wrapper := range wrappers {
		result = wrapper + result + wrapper
	}

	return result
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
