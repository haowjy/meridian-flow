package tools

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"meridian/internal/domain"
	"meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// TextEditorToolMetadata returns metadata for the str_replace_based_edit_tool tool.
// This unified tool replaces both doc_view and doc_edit.
// This enables OCP compliance - tool self-describes for system prompt generation.
func TextEditorToolMetadata() *ToolMetadata {
	return &ToolMetadata{
		Name:        "str_replace_based_edit_tool",
		Description: "View and edit documents (view to read, str_replace/insert/create to modify)",
		Guideline:   "Always use 'view' command first to see current content before editing",
	}
}

// TextEditorTool implements the unified 'str_replace_based_edit_tool' tool.
// Combines view (reading documents/folders) and edit (modifying documents) operations.
// This matches Anthropic's text_editor_20250728 API for seamless provider mapping.
//
// Uses service layer for all data access (SOLID: DIP - depends on interfaces).
// Access to /.meridian/** is DENIED for edit commands - use dedicated skill editor API instead.
//
// Schema docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
type TextEditorTool struct {
	projectID    string
	userID       string                        // Required for service layer authorization
	documentSvc  docsysSvc.DocumentService     // For document operations
	folderSvc    docsysSvc.FolderService       // For folder operations
	namespaceSvc docsysSvc.NamespaceService    // For namespace routing (optional)
	pathResolver *PathResolver                 // For folder path resolution
	config       *ToolConfig
}

// NewTextEditorTool creates a new TextEditorTool instance.
// Uses service interfaces for all data access (SOLID: DIP - depends on interfaces, not concretions).
func NewTextEditorTool(
	projectID string,
	userID string,
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	namespaceSvc docsysSvc.NamespaceService,
	config *ToolConfig,
) *TextEditorTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &TextEditorTool{
		projectID:    projectID,
		userID:       userID,
		documentSvc:  documentSvc,
		folderSvc:    folderSvc,
		namespaceSvc: namespaceSvc,
		pathResolver: NewPathResolver(projectID, userID, folderSvc),
		config:       config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - command (string, required): "view", "str_replace", "create", or "insert"
//   - path (string, required): Unix-style path to document or folder
//   - view_range (array, optional): [start_line, end_line] for view command
//   - old_str (string): For str_replace - exact text to find
//   - new_str (string): For str_replace/insert - new text to insert
//   - insert_line (integer): For insert - line number to insert after (0 = start)
//   - file_text (string): For create - initial document content
func (t *TextEditorTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Extract and validate command
	command, ok := input["command"].(string)
	if !ok || command == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "command"}), nil
	}

	// Extract and validate path
	path, ok := input["path"].(string)
	if !ok || path == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "path"}), nil
	}

	// Normalize path
	path = normalizePath(path)

	// Execute the appropriate command
	switch command {
	case "view":
		return t.executeView(ctx, path, input)
	case "str_replace":
		return t.executeStrReplace(ctx, path, input)
	case "insert":
		return t.executeInsert(ctx, path, input)
	case "create":
		return t.executeCreate(ctx, path, input)
	default:
		return ErrorResult(ErrInvalidInput, "Unknown command", map[string]any{
			"value":   command,
			"allowed": []string{"view", "str_replace", "create", "insert"},
		}), nil
	}
}

// executeView reads a document's content or lists a folder's contents.
// Output includes line numbers in content (matches Anthropic's format).
func (t *TextEditorTool) executeView(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Note: view command CAN access /.meridian/** paths for reference materials

	// Special case: root folder
	if path == "/" {
		return t.listFolderContents(ctx, nil, "/")
	}

	// Try to get as document first (using service layer)
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
	if err == nil {
		// Found a document - format with line numbers
		return t.formatDocumentWithLineNumbers(doc, input)
	}

	// If not found as document, try as folder
	if !errors.Is(err, domain.ErrNotFound) {
		// Unexpected error
		return nil, fmt.Errorf("failed to resolve path: %w", err)
	}

	// Try to resolve as folder
	folderID, folderPath, err := t.pathResolver.ResolveFolderPath(ctx, path)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrNotFound, "Path not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to resolve folder path: %w", err)
	}

	// List folder contents
	return t.listFolderContents(ctx, folderID, folderPath)
}

// formatDocumentWithLineNumbers converts a document to the tool result format with line numbers.
// Output format matches Anthropic's text_editor: "1: line1\n2: line2\n..."
func (t *TextEditorTool) formatDocumentWithLineNumbers(doc *docsystem.Document, input map[string]interface{}) (interface{}, error) {
	// AI sees ai_version if it exists (includes AI's pending suggestions)
	// Otherwise sees user's content
	content := doc.Content
	if doc.AIVersion != nil {
		content = *doc.AIVersion
	}

	lines := strings.Split(content, "\n")
	totalLines := len(lines)

	// Parse view_range if provided
	startLine := 1
	endLine := totalLines
	if viewRange, ok := input["view_range"].([]interface{}); ok && len(viewRange) == 2 {
		if start, ok := viewRange[0].(float64); ok {
			startLine = int(start)
			if startLine < 1 {
				startLine = 1
			}
		}
		if end, ok := viewRange[1].(float64); ok {
			endLine = int(end)
			// -1 means read to end
			if endLine == -1 || endLine > totalLines {
				endLine = totalLines
			}
		}
	}

	// Validate range
	if startLine > totalLines {
		startLine = totalLines
	}
	if endLine < startLine {
		endLine = startLine
	}

	// Extract lines in range and format with line numbers
	var result strings.Builder
	for i := startLine - 1; i < endLine && i < totalLines; i++ {
		fmt.Fprintf(&result, "%d: %s\n", i+1, lines[i])
	}

	formattedContent := strings.TrimSuffix(result.String(), "\n")
	wasTruncated := false

	// Truncate content if too large
	if len(formattedContent) > t.config.MaxContentSize {
		formattedContent = formattedContent[:t.config.MaxContentSize]
		wasTruncated = true
	}

	// Compute word count on-the-fly if not in metadata
	wordCount := doc.WordCount()
	if wordCount == 0 && len(content) > 0 {
		wordCount = len(strings.Fields(content))
	}

	return map[string]interface{}{
		"type":          "document",
		"id":            doc.ID,
		"name":          doc.Filename(),
		"path":          doc.Path,
		"content":       formattedContent,
		"total_lines":   totalLines,
		"view_range":    []int{startLine, endLine},
		"word_count":    wordCount,
		"was_truncated": wasTruncated,
	}, nil
}

// listFolderContents lists documents and subfolders in a folder.
func (t *TextEditorTool) listFolderContents(ctx context.Context, folderID *string, folderPath string) (interface{}, error) {
	contents, err := t.folderSvc.ListChildren(ctx, t.userID, folderID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder contents: %w", err)
	}

	// Format documents (metadata only, no content)
	docList := make([]map[string]interface{}, len(contents.Documents))
	for i, doc := range contents.Documents {
		docList[i] = map[string]interface{}{
			"id":         doc.ID,
			"name":       doc.Filename(),
			"word_count": doc.WordCount(),
			"updated_at": doc.UpdatedAt,
		}
	}

	// Format folders
	folderList := make([]map[string]interface{}, len(contents.Folders))
	for i, folder := range contents.Folders {
		folderList[i] = map[string]interface{}{
			"id":   folder.ID,
			"name": folder.Name,
		}
	}

	return map[string]interface{}{
		"type":      "folder",
		"path":      folderPath,
		"documents": docList,
		"folders":   folderList,
	}, nil
}

// executeStrReplace handles the str_replace command.
// Replaces exact text in the document's ai_version (or content if no ai_version).
func (t *TextEditorTool) executeStrReplace(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access - edit DENIED for /.meridian/**
	if err := t.checkEditNamespaceAccess(path); err != nil {
		return err, nil
	}

	// Extract parameters
	oldStr, ok := input["old_str"].(string)
	if !ok || oldStr == "" {
		return ErrorResult(ErrMissingParam, "str_replace requires old_str parameter", map[string]any{"param": "old_str"}), nil
	}
	newStr, _ := input["new_str"].(string) // Can be empty string (deletion)

	// Get document
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
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
		return ErrorResult(ErrNoMatch, "Text not found in document. Use view command to see current content and try again.", nil), nil
	}

	// Check for ambiguous match (multiple occurrences)
	if strings.Count(base, oldStr) > 1 {
		return ErrorResult(ErrAmbiguousMatch, "Multiple matches found", map[string]any{"count": strings.Count(base, oldStr)}), nil
	}

	// Apply replacement
	newVersion := strings.Replace(base, oldStr, newStr, 1)

	// Save to ai_version
	if _, err := t.documentSvc.UpdateAIVersion(ctx, t.userID, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": "Suggested text replacement",
	}, nil
}

// executeInsert handles the insert command.
// Inserts new text after a specific line number.
func (t *TextEditorTool) executeInsert(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access
	if err := t.checkEditNamespaceAccess(path); err != nil {
		return err, nil
	}

	// Extract parameters
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
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
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
	newLines := make([]string, 0, len(lines)+1)
	newLines = append(newLines, lines[:insertLine]...)
	newLines = append(newLines, newStr)
	newLines = append(newLines, lines[insertLine:]...)
	newVersion := strings.Join(newLines, "\n")

	// Save to ai_version
	if _, err := t.documentSvc.UpdateAIVersion(ctx, t.userID, doc.ID, &newVersion); err != nil {
		return nil, fmt.Errorf("failed to save ai_version: %w", err)
	}

	return map[string]interface{}{
		"path":    path,
		"message": fmt.Sprintf("Suggested insertion after line %d", insertLine),
	}, nil
}

// executeCreate handles the create command.
// Creates a new document with content in ai_version for human review.
func (t *TextEditorTool) executeCreate(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access
	if err := t.checkEditNamespaceAccess(path); err != nil {
		return err, nil
	}

	// Extract parameters
	var fileText string
	if raw, exists := input["file_text"]; !exists {
		fileText = ""
	} else {
		var ok bool
		fileText, ok = raw.(string)
		if !ok {
			return ErrorResult(ErrInvalidInput, "file_text must be a string", map[string]any{"param": "file_text"}), nil
		}
	}

	// Check if document already exists
	_, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
	if err == nil {
		return ErrorResult(ErrDocAlreadyExists, "Document already exists", map[string]any{"path": path}), nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return nil, fmt.Errorf("failed to check document existence: %w", err)
	}

	// Parse path into folder path and document name
	folderPath, fullName := splitDocPath(path)

	// Split filename into name and extension
	ext := filepath.Ext(fullName)
	name := strings.TrimSuffix(fullName, ext)
	if ext == "" {
		ext = docsystem.DefaultExtension // Default to .md
	}

	// Prepare folder path for service
	var folderPathPtr *string
	if folderPath != "/" && folderPath != "" {
		cleanPath := strings.TrimPrefix(folderPath, "/")
		folderPathPtr = &cleanPath
	}

	// Create document with empty content
	createReq := &docsysSvc.CreateDocumentRequest{
		ProjectID:  t.projectID,
		UserID:     t.userID,
		FolderPath: folderPathPtr,
		Name:       name,
		Extension:  ext,
		Content:    "", // Empty content - AI content goes to ai_version for review
	}
	doc, err := t.documentSvc.CreateDocument(ctx, createReq)
	if err != nil {
		return nil, fmt.Errorf("failed to create document: %w", err)
	}

	// Set AI-generated content as ai_version for human review
	if fileText != "" {
		if _, err := t.documentSvc.UpdateAIVersion(ctx, t.userID, doc.ID, &fileText); err != nil {
			return nil, fmt.Errorf("failed to save ai_version: %w", err)
		}
	}

	return map[string]interface{}{
		"path":       path,
		"message":    "Created new document with suggested content",
		"documentId": doc.ID,
	}, nil
}

// checkEditNamespaceAccess checks if edit operations are allowed for the given path.
// Returns an ErrorResult if access is denied, nil otherwise.
func (t *TextEditorTool) checkEditNamespaceAccess(path string) interface{} {
	if t.namespaceSvc != nil {
		namespace, _, err := t.namespaceSvc.ParsePath(path)
		if err == nil && namespace == docsysSvc.NamespaceMeridian {
			return ErrorResult(ErrInvalidInput, "Edit commands cannot modify /.meridian/ paths - use skill editor API instead", map[string]any{
				"path": path,
			})
		}
		if err == nil && namespace == docsysSvc.NamespaceSession {
			return ErrorResult(ErrInvalidInput, "Edit commands cannot modify /.session/ paths", map[string]any{
				"path": path,
			})
		}
	}
	return nil
}
