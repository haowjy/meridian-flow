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
	// Extract and validate command
	command, ok := input["command"].(string)
	if !ok || command == "" {
		return nil, errors.New("missing required parameter: command")
	}

	// Extract and validate path
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return nil, errors.New("missing required parameter: path")
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
		return nil, fmt.Errorf("unknown command: %s (expected: str_replace, insert, append, create)", command)
	}
}

// executeStrReplace handles the str_replace command.
// Replaces exact text in the document's ai_version (or content if no ai_version).
func (t *EditTool) executeStrReplace(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters
	oldStr, ok := input["old_str"].(string)
	if !ok || oldStr == "" {
		return nil, errors.New("str_replace requires old_str parameter")
	}
	newStr, _ := input["new_str"].(string) // Can be empty string (deletion)

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return errorResult("DOC_NOT_FOUND", fmt.Sprintf("Document not found: %s", path)), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Get base content (ai_version if exists, else content)
	base := getBase(doc)

	// Validate old_str exists in base
	if !strings.Contains(base, oldStr) {
		return errorResult("NO_MATCH", "Text not found in document. Use doc_view to see current content and try again."), nil
	}

	// Check for ambiguous match (multiple occurrences)
	if strings.Count(base, oldStr) > 1 {
		return errorResult("AMBIGUOUS_MATCH", fmt.Sprintf("Text appears %d times. Provide more surrounding context to make the match unique.", strings.Count(base, oldStr))), nil
	}

	// Apply replacement
	newVersion := strings.Replace(base, oldStr, newStr, 1)

	// Save to ai_version
	if err := t.documentRepo.UpdateAIVersion(ctx, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return successResult(path, "Suggested text replacement"), nil
}

// executeInsert handles the insert command.
// Inserts new text after a specific line number.
func (t *EditTool) executeInsert(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters
	insertLineFloat, ok := input["insert_line"].(float64) // JSON numbers are float64
	if !ok {
		return nil, errors.New("insert requires insert_line parameter (integer)")
	}
	insertLine := int(insertLineFloat)

	newStr, ok := input["new_str"].(string)
	if !ok {
		return nil, errors.New("insert requires new_str parameter")
	}

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return errorResult("DOC_NOT_FOUND", fmt.Sprintf("Document not found: %s", path)), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Get base content
	base := getBase(doc)
	lines := strings.Split(base, "\n")

	// Validate line number (0 = insert at beginning, len(lines) = insert at end)
	if insertLine < 0 || insertLine > len(lines) {
		return errorResult("INVALID_LINE", fmt.Sprintf("Line %d out of range. Document has %d lines (valid range: 0-%d).", insertLine, len(lines), len(lines))), nil
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

	return successResult(path, fmt.Sprintf("Suggested insertion after line %d", insertLine)), nil
}

// executeAppend handles the append command.
// Adds text to the end of the document.
func (t *EditTool) executeAppend(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters
	newStr, ok := input["new_str"].(string)
	if !ok || newStr == "" {
		return nil, errors.New("append requires new_str parameter")
	}

	// Get document
	doc, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return errorResult("DOC_NOT_FOUND", fmt.Sprintf("Document not found: %s", path)), nil
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

	return successResult(path, "Suggested appending text to document"), nil
}

// executeCreate handles the create command.
// Creates a new document (immediately, not as ai_version suggestion).
func (t *EditTool) executeCreate(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Extract parameters
	fileText, ok := input["file_text"].(string)
	if !ok {
		return nil, errors.New("create requires file_text parameter")
	}

	// Check if document already exists
	_, err := t.documentRepo.GetByPath(ctx, path, t.projectID)
	if err == nil {
		return errorResult("ALREADY_EXISTS", fmt.Sprintf("Document already exists: %s. Use str_replace, insert, or append to modify it.", path)), nil
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

	return successResult(path, "Created new document"), nil
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

// successResult creates a successful tool result.
func successResult(path, message string) map[string]interface{} {
	return map[string]interface{}{
		"success": true,
		"path":    path,
		"message": message,
	}
}

// errorResult creates an error tool result (returned, not thrown).
// Error codes help the LLM understand what went wrong and how to recover.
func errorResult(code, message string) map[string]interface{} {
	return map[string]interface{}{
		"success":    false,
		"error_code": code,
		"message":    message,
	}
}
