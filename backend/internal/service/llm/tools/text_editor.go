package tools

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"
	domainerrors "meridian/internal/domain/errors"
)

// TextEditorToolMetadata returns metadata for the str_replace_based_edit_tool tool.
// This unified tool replaces the former doc_view, doc_tree, and doc_edit tools.
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
// Access to /.meridian/** and /.session/** is DENIED for edit commands. /.agents/** is writable but review-gated via folder autoapply.
//
// Schema docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
type TextEditorTool struct {
	projectID        string
	userID           string                        // Required for service layer authorization
	documentSvc      domaindocsys.DocumentService  // For document operations
	folderSvc        domaindocsys.FolderService    // For folder operations
	namespaceSvc     domaindocsys.NamespaceService // For namespace routing (optional)
	pathResolver     *DocumentPathResolver         // For folder path resolution
	config           *ToolConfig
	normalizers      []TextNormalizer         // For str_replace text normalization (OCP)
	mutationStrategy DocumentMutationStrategy // Strategy for persisting AI edits (collab proposal)
	workItemSlug     string                   // Current work item slug for .meridian/work/<slug>/ isolation
}

// NewTextEditorTool creates a new TextEditorTool instance.
// Uses service interfaces for all data access (SOLID: DIP - depends on interfaces, not concretions).
// workItemSlug constrains .meridian/work/<slug>/ write access to the current work item only.
// Pass an empty string when no work item context is active (all work dirs will be denied).
func NewTextEditorTool(
	projectID string,
	userID string,
	documentSvc domaindocsys.DocumentService,
	folderSvc domaindocsys.FolderService,
	namespaceSvc domaindocsys.NamespaceService,
	config *ToolConfig,
	mutationStrategy DocumentMutationStrategy,
	workItemSlug string,
) *TextEditorTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	if mutationStrategy == nil {
		panic("mutationStrategy is required")
	}
	return &TextEditorTool{
		projectID:        projectID,
		userID:           userID,
		documentSvc:      documentSvc,
		folderSvc:        folderSvc,
		namespaceSvc:     namespaceSvc,
		pathResolver:     NewPathResolver(projectID, userID, folderSvc),
		config:           config,
		normalizers:      DefaultNormalizers(), // OCP: extensible without modifying str_replace logic
		mutationStrategy: mutationStrategy,
		workItemSlug:     workItemSlug,
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
func (t *TextEditorTool) formatDocumentWithLineNumbers(doc *domaindocsys.Document, input map[string]interface{}) (interface{}, error) {
	content := doc.Content

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

	wordCount := doc.WordCount()

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
// Replaces exact text in the document content.
//
// Smart text normalization: Uses the normalizer chain (OCP) to handle common LLM mistakes
// like including line number prefixes from view output. Normalizers are tried in order
// until a match is found, allowing easy extension without modifying this function.
func (t *TextEditorTool) executeStrReplace(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access before any write operation.
	if nsErr := t.checkEditNamespaceAccess(path); nsErr != nil {
		return t.namespaceErrToToolResult(nsErr), nil
	}

	// Extract parameters
	oldStr, ok := input["old_str"].(string)
	if !ok || oldStr == "" {
		return ErrorResult(ErrMissingParam, "str_replace requires old_str parameter", map[string]any{"param": "old_str"}), nil
	}
	newStr, _ := input["new_str"].(string) // Can be empty string (deletion)

	// Get document (for ID and metadata)
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrDocNotFound, "document not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	base := doc.Content

	// Try to match using normalizer chain (OCP: extensible without modifying this function)
	result, errMsg := tryMatchWithNormalizers(base, oldStr, newStr, t.normalizers)
	if result == nil {
		if strings.HasPrefix(errMsg, "AMBIGUOUS_MATCH:") {
			return ErrorResult(ErrAmbiguousMatch, "Multiple matches found", nil), nil
		}
		return ErrorResult(ErrNoMatch, errMsg, nil), nil
	}

	// Check for ambiguous match (multiple occurrences)
	if strings.Count(base, result.matchedOld) > 1 {
		msg := "Multiple matches found"
		if result.appliedNorm != "" {
			msg += " after applying " + result.appliedNorm + " normalization"
		}
		return ErrorResult(ErrAmbiguousMatch, msg, map[string]any{
			"count": strings.Count(base, result.matchedOld),
		}), nil
	}

	// Apply replacement
	newVersion := strings.Replace(base, result.matchedOld, result.normalizedNew, 1)

	// Build description
	description := "Suggested text replacement"
	if result.appliedNorm != "" {
		description += " (" + result.appliedNorm + " normalization applied)"
	}

	// Persist via mutation strategy (collab proposal)
	mutResult, err := t.mutationStrategy.Apply(ctx, MutationInput{
		DocumentID:  doc.ID,
		UserID:      t.userID,
		Path:        path,
		Base:        base,
		NewContent:  newVersion,
		OldContent:  result.matchedOld,
		ReplContent: result.normalizedNew,
		Description: description,
	})
	if err != nil {
		return nil, err
	}

	resp := map[string]interface{}{
		"path":    path,
		"message": mutResult.Message,
	}
	for k, v := range mutResult.Extra {
		resp[k] = v
	}
	return resp, nil
}

// executeInsert handles the insert command.
// Inserts new text after a specific line number.
func (t *TextEditorTool) executeInsert(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access before any write operation.
	if nsErr := t.checkEditNamespaceAccess(path); nsErr != nil {
		return t.namespaceErrToToolResult(nsErr), nil
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

	// Get document (for ID and metadata)
	doc, err := t.documentSvc.GetDocumentByPath(ctx, t.userID, path, t.projectID)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return ErrorResult(ErrDocNotFound, "document not found", map[string]any{"path": path}), nil
		}
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	base := doc.Content
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

	// Persist via mutation strategy (collab proposal)
	description := fmt.Sprintf("Suggested insertion after line %d", insertLine)
	mutResult, err := t.mutationStrategy.Apply(ctx, MutationInput{
		DocumentID:  doc.ID,
		UserID:      t.userID,
		Path:        path,
		Base:        base,
		NewContent:  newVersion,
		Description: description,
	})
	if err != nil {
		return nil, err
	}

	resp := map[string]interface{}{
		"path":    path,
		"message": mutResult.Message,
	}
	for k, v := range mutResult.Extra {
		resp[k] = v
	}
	return resp, nil
}

// executeCreate handles the create command.
// Creates a new document via the mutation strategy for human review.
func (t *TextEditorTool) executeCreate(ctx context.Context, path string, input map[string]interface{}) (interface{}, error) {
	// Check namespace access before any write operation.
	if nsErr := t.checkEditNamespaceAccess(path); nsErr != nil {
		return t.namespaceErrToToolResult(nsErr), nil
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
		ext = domaindocsys.DefaultExtension // Default to .md
	}

	// Prepare folder path for service
	var folderPathPtr *string
	if folderPath != "/" && folderPath != "" {
		cleanPath := strings.TrimPrefix(folderPath, "/")
		folderPathPtr = &cleanPath
	}

	// Create document with empty content
	createReq := &domaindocsys.CreateDocumentRequest{
		ProjectID:  t.projectID,
		UserID:     t.userID,
		FolderPath: folderPathPtr,
		Name:       name,
		Extension:  ext,
		Content:    "", // Empty content - AI content goes through mutation strategy as proposal
	}
	doc, err := t.documentSvc.CreateDocument(ctx, createReq)
	if err != nil {
		return nil, fmt.Errorf("failed to create document: %w", err)
	}

	// Set AI-generated content via mutation strategy for human review
	if fileText != "" {
		mutResult, err := t.mutationStrategy.Apply(ctx, MutationInput{
			DocumentID:  doc.ID,
			UserID:      t.userID,
			Path:        path,
			Base:        "", // New document has empty content
			NewContent:  fileText,
			Description: "Created new document with suggested content",
		})
		if err != nil {
			return nil, fmt.Errorf("failed to save ai content: %w", err)
		}

		resp := map[string]interface{}{
			"path":       path,
			"message":    mutResult.Message,
			"documentId": doc.ID,
		}
		for k, v := range mutResult.Extra {
			resp[k] = v
		}
		return resp, nil
	}

	return map[string]interface{}{
		"path":       path,
		"message":    "Created new document with suggested content",
		"documentId": doc.ID,
	}, nil
}

// checkEditNamespaceAccess enforces namespace isolation rules for write operations.
// Returns a *domainerrors.DomainError if access is denied, nil if allowed.
//
// Mandatory order: canonicalize → detect namespace → check isolation.
// filepath.Clean MUST run before any prefix matching so that path traversal (..)
// is resolved to its canonical form before we decide which namespace it targets.
//
// Rules:
//   - .meridian/work/<slug>/  → only the current workItemSlug may write here
//   - .meridian/fs/           → any thread may write (shared FS namespace)
//   - .agents/                → allowed; review-gated via folder autoapply
//   - .meridian/<anything>    → denied (NamespaceAccessDenied)
//   - .session/<anything>     → denied (NamespaceAccessDenied)
//   - everything else         → allowed (user workspace)
func (t *TextEditorTool) checkEditNamespaceAccess(path string) error {
	// Step 1: Canonicalize — resolve all . and .. segments.
	// MUST happen before any prefix matching; otherwise a path like
	// ".meridian/work/slug/../../other/secret" could bypass namespace detection.
	clean := filepath.Clean(path)

	// Step 2: Reject raw traversal segments on the original (pre-Clean) path.
	// filepath.Clean already ran in Step 1, but we also check the original input
	// so that an explicit ".." segment returns PathTraversalDenied rather than
	// silently resolving to a different namespace after canonicalisation.
	for _, seg := range strings.Split(path, "/") {
		if seg == ".." {
			return domainerrors.PathTraversalDenied(path)
		}
	}

	// Step 3: Namespace detection and isolation check on the canonical path.
	// Strip the leading "/" so prefix matching works uniformly against the
	// namespace constants (which do not carry a leading slash).
	cleanRel := strings.TrimPrefix(clean, "/")

	// .meridian/work/<slug>/ — work item isolation
	const workPrefix = ".meridian/work/"
	if cleanRel == ".meridian/work" || strings.HasPrefix(cleanRel, workPrefix) {
		rest := strings.TrimPrefix(cleanRel, workPrefix)
		// Extract just the slug component (everything before the first "/")
		slugEnd := strings.Index(rest, "/")
		var pathSlug string
		if slugEnd == -1 {
			pathSlug = rest // path is the slug directory itself
		} else {
			pathSlug = rest[:slugEnd]
		}
		if pathSlug == "" || pathSlug != t.workItemSlug {
			return domainerrors.NamespaceAccessDenied(".meridian/work/" + pathSlug)
		}
		return nil
	}

	// .meridian/fs/ — shared filesystem namespace, any thread allowed
	if cleanRel == ".meridian/fs" || strings.HasPrefix(cleanRel, ".meridian/fs/") {
		return nil
	}

	// .agents/ — writable; review is enforced via folder autoapply, not write-blocking
	if cleanRel == string(domaindocsys.NamespaceAgents) ||
		strings.HasPrefix(cleanRel, string(domaindocsys.NamespaceAgents)+"/") {
		return nil
	}

	// Other .meridian/ paths — denied
	if cleanRel == string(domaindocsys.NamespaceMeridian) ||
		strings.HasPrefix(cleanRel, string(domaindocsys.NamespaceMeridian)+"/") {
		return domainerrors.NamespaceAccessDenied(string(domaindocsys.NamespaceMeridian))
	}

	// .session/ — ephemeral, no persistence
	if cleanRel == string(domaindocsys.NamespaceSession) ||
		strings.HasPrefix(cleanRel, string(domaindocsys.NamespaceSession)+"/") {
		return domainerrors.NamespaceAccessDenied(string(domaindocsys.NamespaceSession))
	}

	// Workspace paths — allowed
	return nil
}

// namespaceErrToToolResult converts a *domainerrors.DomainError from checkEditNamespaceAccess
// into a tool-facing ErrorResult map.  Any non-DomainError is wrapped as INVALID_INPUT.
func (t *TextEditorTool) namespaceErrToToolResult(err error) map[string]interface{} {
	var de *domainerrors.DomainError
	if errors.As(err, &de) {
		detail, _ := de.Detail.(map[string]interface{})
		return ErrorResult(de.Code, de.Message, detail)
	}
	return ErrorResult(ErrInvalidInput, err.Error(), nil)
}

// =============================================================================
// SHARED HELPERS (used by text editor operations)
// =============================================================================

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
// "/chapters/ch1.md" -> ("/chapters", "ch1.md")
// "/readme.md" -> ("/", "readme.md")
func splitDocPath(path string) (folderPath, docName string) {
	path = strings.TrimPrefix(path, "/")
	lastSlash := strings.LastIndex(path, "/")
	if lastSlash == -1 {
		return "/", path
	}
	return "/" + path[:lastSlash], path[lastSlash+1:]
}
