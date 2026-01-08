package tools

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsystemRepo "meridian/internal/domain/repositories/docsystem"
)

// EditTool implements the 'doc_edit' tool for editing document content.
// Edits are written to documents.ai_version for user review before acceptance.
type EditTool struct {
	projectID    string
	documentRepo docsystemRepo.DocumentRepository
	folderRepo   docsystemRepo.FolderRepository
	pathResolver *PathResolver
	config       *ToolConfig
}

// NewEditTool creates a new EditTool instance.
func NewEditTool(
	projectID string,
	documentRepo docsystemRepo.DocumentRepository,
	folderRepo docsystemRepo.FolderRepository,
	config *ToolConfig,
) *EditTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &EditTool{
		projectID:    projectID,
		documentRepo: documentRepo,
		folderRepo:   folderRepo,
		pathResolver: NewPathResolver(projectID, folderRepo),
		config:       config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - command (string, required): "str_replace", "insert", "append", or "create"
//   - path (string, required): Unix-style path to document
//   - old_str (string): For str_replace - exact text to find
//   - new_str (string): For str_replace/insert/append - new text to insert
//   - insert_line (integer): For insert - line number to insert after (0 = start)
//   - file_text (string): For create - initial document content
func (t *EditTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Extract and validate command (recoverable error - LLM can retry)
	command, ok := input["command"].(string)
	if !ok || command == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "command"}), nil
	}

	// Extract and validate path (recoverable error - LLM can retry)
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "path"}), nil
	}

	// Normalize path
	path = normalizePath(path)

	// Execute the appropriate command
	switch command {
	case "str_replace":
		return t.executeStrReplace(ctx, path, input)
	case "insert":
		return t.executeInsert(ctx, path, input)
	case "append":
		return t.executeAppend(ctx, path, input)
	case "create":
		return t.executeCreate(ctx, path, input)
	default:
		// Recoverable error - LLM can retry with valid command
		return ErrorResult(ErrInvalidInput, "Unknown command", map[string]any{
			"value":   command,
			"allowed": []string{"str_replace", "insert", "append", "create"},
		}), nil
	}
}

// executeStrReplace handles the str_replace command.
// Replaces exact text in the document's ai_version (or content if no ai_version).
func (t *EditTool) executeStrReplace(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters (recoverable error - LLM can retry)
	oldStr, ok := input["old_str"].(string)
	if !ok || oldStr == "" {
		return ErrorResult(ErrMissingParam, "str_replace requires old_str parameter", map[string]any{"param": "old_str"}), nil
	}
	newStr, _ := input["new_str"].(string) // Can be empty string (deletion)

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrDocNotFound, "Document not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Get base content (ai_version if exists, else content)
	base := getBase(doc)

	// Validate old_str exists in base
	if !strings.Contains(base, oldStr) {
		return ErrorResult(ErrNoMatch, "Text not found in document. Use doc_view to see current content and try again.", nil), nil
	}

	// Check for ambiguous match (multiple occurrences)
	if strings.Count(base, oldStr) > 1 {
		return ErrorResult(ErrAmbiguousMatch, "Multiple matches found", map[string]any{"count": strings.Count(base, oldStr)}), nil
	}

	// Apply replacement
	newVersion := strings.Replace(base, oldStr, newStr, 1)

	// Save to ai_version
	if err := t.documentRepo.UpdateAIVersion(ctx, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": "Suggested text replacement",
	}, nil
}

// executeInsert handles the insert command.
// Inserts new text after a specific line number.
func (t *EditTool) executeInsert(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters (recoverable error - LLM can retry)
	insertLineFloat, ok := input["insert_line"].(float64) // JSON numbers are float64
	if !ok {
		return ErrorResult(ErrMissingParam, "insert requires insert_line parameter (integer)", map[string]any{"param": "insert_line"}), nil
	}
	insertLine := int(insertLineFloat)

	newStr, ok := input["new_str"].(string)
	if !ok {
		return ErrorResult(ErrMissingParam, "insert requires new_str parameter", map[string]any{"param": "new_str"}), nil
	}

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrDocNotFound, "Document not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Get base content
	base := getBase(doc)
	lines := strings.Split(base, "\n")

	// Validate line number (0 = insert at beginning, len(lines) = insert at end)
	if insertLine < 0 || insertLine > len(lines) {
		return ErrorResult(ErrInvalidLine, "Line out of range", map[string]any{"line": insertLine, "max": len(lines)}), nil
	}

	// Insert after line N
	// insertLine=0 means insert at the very beginning (before line 1)
	// insertLine=1 means insert after line 1
	newLines := make([]string, 0, len(lines)+1)
	newLines = append(newLines, lines[:insertLine]...)
	newLines = append(newLines, newStr)
	newLines = append(newLines, lines[insertLine:]...)
	newVersion := strings.Join(newLines, "\n")

	// Save to ai_version
	if err := t.documentRepo.UpdateAIVersion(ctx, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": fmt.Sprintf("Suggested insertion after line %d", insertLine),
	}, nil
}

// executeAppend handles the append command.
// Adds text to the end of the document.
func (t *EditTool) executeAppend(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters (recoverable error - LLM can retry)
	newStr, ok := input["new_str"].(string)
	if !ok || newStr == "" {
		return ErrorResult(ErrMissingParam, "append requires new_str parameter", map[string]any{"param": "new_str"}), nil
	}

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrDocNotFound, "Document not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Get base content and append
	base := getBase(doc)
	newVersion := base
	if !strings.HasSuffix(base, "\n") {
		newVersion += "\n"
	}
	newVersion += newStr

	// Save to ai_version
	if err := t.documentRepo.UpdateAIVersion(ctx, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": "Suggested appending text to document",
	}, nil
}

// executeCreate handles the create command.
// Creates a new document (immediately, not as ai_version suggestion).
func (t *EditTool) executeCreate(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters (recoverable error - LLM can retry)
	fileText, ok := input["file_text"].(string)
	if !ok {
		return ErrorResult(ErrMissingParam, "create requires file_text parameter", map[string]any{"param": "file_text"}), nil
	}

	// Check if document already exists
	_, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err == nil {
		return ErrorResult(ErrDocAlreadyExists, "Document already exists", map[string]any{"path": path}), nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("failed to check document existence: %w", err)
	}

	// Parse path into folder path and document name
	folderPath, docName := splitDocPath(path)

	// Resolve or create the folder hierarchy
	folderID, err := t.resolveOrCreateFolder(ctx, folderPath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve folder path: %w", err)
	}

	// Create the document
	doc := &docsystem.Document{
		ProjectID: t.projectID,
		FolderID:  folderID,
		Name:      docName,
		Content:   fileText,
	}
	if err := t.documentRepo.Create(ctx, doc); err != nil {
		return nil, fmt.Errorf("failed to create document: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": "Created new document",
	}, nil
}

// resolveOrCreateFolder ensures the folder path exists, creating folders as needed.
// Returns the folder ID (or nil for root).
func (t *EditTool) resolveOrCreateFolder(ctx context.Context, folderPath string) (*string, error) {
	// Handle root folder
	if folderPath == "/" || folderPath == "" {
		return nil, nil
	}

	// Parse path into segments
	folderPath = strings.Trim(folderPath, "/")
	segments := strings.Split(folderPath, "/")

	// Walk/create each segment
	var currentFolderID *string
	for _, segment := range segments {
		segment = strings.TrimSpace(segment)
		if segment == "" {
			continue
		}

		// Create folder if it doesn't exist
		folder, err := t.folderRepo.CreateIfNotExists(ctx, t.projectID, currentFolderID, segment)
		if err != nil {
			return nil, fmt.Errorf("failed to create folder '%s': %w", segment, err)
		}
		currentFolderID = &folder.ID
	}

	return currentFolderID, nil
}

// Helper functions

// getBase returns ai_version if it exists, otherwise content.
// AI edits accumulate in ai_version; first edit initializes from content.
func getBase(doc *docsystem.Document) string {
	if doc.AIVersion != nil {
		return *doc.AIVersion
	}
	return doc.Content
}

// normalizePath ensures path starts with / and has no trailing /
func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	// Remove trailing slash (unless it's just "/")
	if len(path) > 1 && strings.HasSuffix(path, "/") {
		path = strings.TrimSuffix(path, "/")
	}
	return path
}

// splitDocPath splits a document path into folder path and document name.
// "/chapters/ch1.md" → ("/chapters", "ch1.md")
// "/readme.md" → ("/", "readme.md")
func splitDocPath(path string) (folderPath, docName string) {
	path = strings.TrimPrefix(path, "/")
	lastSlash := strings.LastIndex(path, "/")
	if lastSlash == -1 {
		return "/", path
	}
	return "/" + path[:lastSlash], path[lastSlash+1:]
}

