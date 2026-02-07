package threadhistory

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"meridian/internal/domain/models/docsystem"
	llmModels "meridian/internal/domain/models/llm"
	domainllm "meridian/internal/domain/services/llm"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/service/llm/formatting"
)

const (
	// syntheticToolName is the tool name used for all synthetic tool_use/tool_result pairs.
	// Matches the real tool name so LLMs recognize synthetic refs as "data I already fetched."
	syntheticToolName = "str_replace_based_edit_tool"
)

// refWithID carries a reference block together with its assigned synthetic tool ID
// and pre-fetched entity (to avoid double-fetching in ghost text + resolution).
type refWithID struct {
	block       *llmModels.TurnBlock
	syntheticID string
	// Cached from ghost text resolution to avoid double-fetching
	resolvedDoc    *docsystem.Document
	resolvedFolder *docsystem.Folder
}

// ReferenceMessageTransformer resolves reference blocks into synthetic tool_use/tool_result
// message pairs. This compiles @-mentions into a format LLMs recognize as "data I already fetched,"
// preventing redundant tool calls from less capable models.
//
// Operates at the message level (post-BuildMessages) because tool_use must be in assistant
// messages and tool_result in user messages — a block-level transform can't split one user
// message into a user→assistant→user sequence.
type ReferenceMessageTransformer struct {
	documentSvc       docsysSvc.DocumentService    // DIP: interface dependency
	folderSvc         docsysSvc.FolderService       // For folder reference resolution
	formatterRegistry *formatting.FormatterRegistry // Same instance as MessageBuilder uses
	userID            string
	projectID         string // Needed for folderSvc.ListChildren
	logger            *slog.Logger
}

// NewReferenceMessageTransformer creates a new ReferenceMessageTransformer.
// userID is the requesting user (for authorization checks on document/folder access).
// projectID is needed for folder listing via folderSvc.ListChildren.
// formatterRegistry ensures synthetic tool results get the same formatting as real ones.
func NewReferenceMessageTransformer(
	documentSvc docsysSvc.DocumentService,
	folderSvc docsysSvc.FolderService,
	formatterRegistry *formatting.FormatterRegistry,
	userID string,
	projectID string,
	logger *slog.Logger,
) *ReferenceMessageTransformer {
	return &ReferenceMessageTransformer{
		documentSvc:       documentSvc,
		folderSvc:         folderSvc,
		formatterRegistry: formatterRegistry,
		userID:            userID,
		projectID:         projectID,
		logger:            logger,
	}
}

// TransformMessages processes all messages, expanding reference blocks in user messages
// into synthetic tool_use/tool_result pairs that LLMs recognize as prior tool calls.
//
// For each user message with references:
//  1. Reference blocks are replaced in-place with ghost text (e.g. "@/path (ref_0_0)")
//     so the LLM can connect the user's instruction to the corresponding tool result
//  2. Each reference becomes a tool_use block (in a synthetic assistant message)
//     and a tool_result block (in a synthetic user message)
//  3. Result: [user msg with ghost text, synthetic assistant (tool_use), synthetic user (tool_result)]
func (rt *ReferenceMessageTransformer) TransformMessages(
	ctx context.Context,
	messages []domainllm.Message,
) ([]domainllm.Message, error) {
	result := make([]domainllm.Message, 0, len(messages))

	for msgIdx, msg := range messages {
		// Only process user messages — assistant messages pass through unchanged
		if msg.Role != "user" {
			result = append(result, msg)
			continue
		}

		// Replace reference blocks with ghost text in-place, collecting refs with IDs
		modifiedBlocks, refsWithIDs := rt.replaceRefsWithGhostText(ctx, msg.Content, msgIdx)
		if len(refsWithIDs) == 0 {
			// No references in this message — pass through unchanged
			result = append(result, msg)
			continue
		}

		// Resolve all references and build synthetic tool_use/tool_result blocks
		var toolUseBlocks []*llmModels.TurnBlock
		var toolResultBlocks []*llmModels.TurnBlock

		for _, rwid := range refsWithIDs {
			useBlock, resultBlock, err := rt.resolveToToolPair(ctx, rwid)
			if err != nil {
				rt.logger.Warn("failed to resolve reference, using error result",
					"error", err,
					"ref_id", extractRefID(rwid.block.Content),
				)
				// Fallback: create error tool_result (same as real tool errors)
				useBlock, resultBlock = rt.errorToolPair(rwid.block, rwid.syntheticID, err)
			}

			toolUseBlocks = append(toolUseBlocks, useBlock)
			toolResultBlocks = append(toolResultBlocks, resultBlock)
		}

		// Ghost text means the user message always has content — no empty-message edge case.
		// Emit: [user msg with ghost text, synthetic assistant (tool_use), synthetic user (tool_result)]
		result = append(result, domainllm.Message{
			Role:    "user",
			Content: modifiedBlocks,
		})
		result = append(result, domainllm.Message{
			Role:    "assistant",
			Content: toolUseBlocks,
		})
		result = append(result, domainllm.Message{
			Role:    "user",
			Content: toolResultBlocks,
		})
	}

	return result, nil
}

// replaceRefsWithGhostText walks blocks in order, replacing reference blocks
// with text placeholders that link to the synthetic tool result IDs.
// Returns the modified block list and the collected reference blocks with their IDs.
//
// Ghost text format: "@/Stories/storm-magic-ideas.md (ref_0_0)"
// This lets the LLM connect: user instruction → ghost text with ID → matching tool_use → matching tool_result.
func (rt *ReferenceMessageTransformer) replaceRefsWithGhostText(
	ctx context.Context,
	blocks []*llmModels.TurnBlock,
	msgIdx int,
) (modifiedBlocks []*llmModels.TurnBlock, refs []refWithID) {
	refIdx := 0
	for _, block := range blocks {
		if block.BlockType != llmModels.BlockTypeReference {
			modifiedBlocks = append(modifiedBlocks, block)
			continue
		}

		syntheticID := fmt.Sprintf("ref_%d_%d", msgIdx, refIdx)

		// Resolve metadata for ghost text and cache the entity to avoid double-fetching
		displayPath, doc, folder := rt.resolveRefMetadata(ctx, block)

		ghostText := fmt.Sprintf("@%s (%s)", displayPath, syntheticID)
		modifiedBlocks = append(modifiedBlocks, &llmModels.TurnBlock{
			BlockType:   llmModels.BlockTypeText,
			TextContent: &ghostText,
		})

		refs = append(refs, refWithID{
			block:          block,
			syntheticID:    syntheticID,
			resolvedDoc:    doc,
			resolvedFolder: folder,
		})
		refIdx++
	}
	return
}

// resolveRefMetadata fetches just enough to build ghost text and caches the entity.
// Returns the display path and the resolved entity (one of doc/folder will be non-nil on success).
func (rt *ReferenceMessageTransformer) resolveRefMetadata(
	ctx context.Context,
	block *llmModels.TurnBlock,
) (displayPath string, doc *docsystem.Document, folder *docsystem.Folder) {
	refType := extractRefType(block.Content)
	refID := extractRefID(block.Content)

	if refType == "folder" {
		var err error
		folder, err = rt.folderSvc.GetFolder(ctx, rt.userID, refID)
		if err != nil {
			displayPath = refID // fallback to ID if resolution fails
			return
		}
		displayPath = folder.Path
	} else {
		var err error
		doc, err = rt.documentSvc.GetDocument(ctx, rt.userID, refID)
		if err != nil {
			displayPath = refID // fallback to ID if resolution fails
			return
		}
		displayPath = doc.Path
	}
	return
}

// resolveToToolPair resolves a reference block into a synthetic tool_use + tool_result pair.
// Uses pre-fetched entities from ghost text resolution to avoid double-fetching.
// The result format matches the real str_replace_based_edit_tool output so the LLM sees identical data.
func (rt *ReferenceMessageTransformer) resolveToToolPair(
	ctx context.Context,
	rwid refWithID,
) (*llmModels.TurnBlock, *llmModels.TurnBlock, error) {
	// Parse reference content
	var ref llmModels.ReferenceContent
	jsonBytes, err := json.Marshal(rwid.block.Content)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to marshal reference content: %w", err)
	}
	if err := json.Unmarshal(jsonBytes, &ref); err != nil {
		return nil, nil, fmt.Errorf("invalid reference content: %w", err)
	}
	if ref.RefID == "" {
		return nil, nil, fmt.Errorf("reference block missing ref_id")
	}

	switch ref.RefType {
	case "folder":
		return rt.resolveFolderToToolPair(ctx, ref, rwid.syntheticID, rwid.resolvedFolder)
	default:
		// "document", "image", "s3_document" — document resolution
		return rt.resolveDocumentToToolPair(ctx, ref, rwid.syntheticID, rwid.resolvedDoc)
	}
}

// resolveDocumentToToolPair creates str_replace_based_edit_tool view-format tool_use + tool_result blocks.
// cachedDoc is the pre-fetched document from ghost text resolution (avoids double-fetch).
// Result format matches TextEditorTool.formatDocumentWithLineNumbers (text_editor.go:190-221).
func (rt *ReferenceMessageTransformer) resolveDocumentToToolPair(
	ctx context.Context,
	ref llmModels.ReferenceContent,
	syntheticID string,
	cachedDoc *docsystem.Document,
) (*llmModels.TurnBlock, *llmModels.TurnBlock, error) {
	doc := cachedDoc
	if doc == nil {
		// Ghost text resolution failed — try again (may still fail → error tool_result)
		var err error
		doc, err = rt.documentSvc.GetDocument(ctx, rt.userID, ref.RefID)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to fetch document %s: %w", ref.RefID, err)
		}
	}

	// Use effective content (ai_version if exists, else content) — matches TextEditorTool behavior
	content := doc.EffectiveContent()

	// Add line numbers to match TextEditorTool.formatDocumentWithLineNumbers format
	lines := strings.Split(content, "\n")
	totalLines := len(lines)
	var numbered strings.Builder
	for i, line := range lines {
		fmt.Fprintf(&numbered, "%d: %s", i+1, line)
		if i < totalLines-1 {
			numbered.WriteString("\n")
		}
	}

	wordCount := doc.WordCount()

	// Synthetic tool_use: "the assistant called str_replace_based_edit_tool view"
	useBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolUse,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"tool_name":   syntheticToolName,
			"input":       map[string]any{"command": "view", "path": doc.Path},
		},
	}

	// Synthetic tool_result: matches TextEditorTool output format (with total_lines, view_range)
	resultBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolResult,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"tool_name":   syntheticToolName,
			"is_error":    false,
			"result": map[string]any{
				"type":          "document",
				"id":            doc.ID,
				"name":          doc.Filename(),
				"path":          doc.Path,
				"content":       numbered.String(),
				"total_lines":   totalLines,
				"view_range":    []int{1, totalLines},
				"word_count":    wordCount,
				"was_truncated": false,
			},
		},
	}

	// Apply same formatting pipeline as real tool results
	// (TextEditorFormatter converts JSON → human-readable text)
	formatting.FormatToolResultContent(rt.formatterRegistry, resultBlock.Content)

	return useBlock, resultBlock, nil
}

// resolveFolderToToolPair creates str_replace_based_edit_tool view-format tool_use + tool_result blocks.
// cachedFolder is the pre-fetched folder from ghost text resolution (avoids double-fetch).
// Result format matches TextEditorTool.listFolderContents (text_editor.go:224-257).
func (rt *ReferenceMessageTransformer) resolveFolderToToolPair(
	ctx context.Context,
	ref llmModels.ReferenceContent,
	syntheticID string,
	cachedFolder *docsystem.Folder,
) (*llmModels.TurnBlock, *llmModels.TurnBlock, error) {
	folder := cachedFolder
	if folder == nil {
		// Ghost text resolution failed — try again (may still fail → error tool_result)
		var err error
		folder, err = rt.folderSvc.GetFolder(ctx, rt.userID, ref.RefID)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to fetch folder %s: %w", ref.RefID, err)
		}
	}

	// Flat listing of immediate children (matches TextEditorTool.listFolderContents)
	contents, err := rt.folderSvc.ListChildren(ctx, rt.userID, &ref.RefID, rt.projectID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to list folder contents for %s: %w", ref.RefID, err)
	}

	// Format documents (metadata only, no content)
	docList := make([]map[string]any, len(contents.Documents))
	for i, doc := range contents.Documents {
		docList[i] = map[string]any{
			"id":         doc.ID,
			"name":       doc.Filename(),
			"word_count": doc.WordCount(),
			"updated_at": doc.UpdatedAt,
		}
	}

	// Format folders
	folderList := make([]map[string]any, len(contents.Folders))
	for i, f := range contents.Folders {
		folderList[i] = map[string]any{
			"id":   f.ID,
			"name": f.Name,
		}
	}

	// Synthetic tool_use: "the assistant called str_replace_based_edit_tool view"
	useBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolUse,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"tool_name":   syntheticToolName,
			"input":       map[string]any{"command": "view", "path": folder.Path},
		},
	}

	// Synthetic tool_result: matches TextEditorTool.listFolderContents output format
	resultBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolResult,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"tool_name":   syntheticToolName,
			"is_error":    false,
			"result": map[string]any{
				"type":      "folder",
				"path":      folder.Path,
				"documents": docList,
				"folders":   folderList,
			},
		},
	}

	// Apply same formatting pipeline as real tool results
	// (TextEditorFormatter converts JSON → indented folder listing text)
	formatting.FormatToolResultContent(rt.formatterRegistry, resultBlock.Content)

	return useBlock, resultBlock, nil
}

// errorToolPair creates a tool_use + error tool_result pair for failed resolution.
// Error tool_results are how real tools report failures, so the LLM handles them naturally.
func (rt *ReferenceMessageTransformer) errorToolPair(
	block *llmModels.TurnBlock,
	syntheticID string,
	resolveErr error,
) (*llmModels.TurnBlock, *llmModels.TurnBlock) {
	refType := extractRefType(block.Content)

	useBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolUse,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"tool_name":   syntheticToolName,
			"input":       map[string]any{"command": "view", "path": extractRefID(block.Content)},
		},
	}

	resultBlock := &llmModels.TurnBlock{
		BlockType: llmModels.BlockTypeToolResult,
		Content: map[string]any{
			"tool_use_id": syntheticID,
			"is_error":    true,
			"error":       fmt.Sprintf("Referenced %s not found: %s", refType, resolveErr.Error()),
		},
	}

	return useBlock, resultBlock
}

// extractRefID safely extracts ref_id from a content map.
func extractRefID(content map[string]interface{}) string {
	if content == nil {
		return "<unknown>"
	}
	if refID, ok := content["ref_id"].(string); ok && refID != "" {
		return refID
	}
	return "<unknown>"
}

// extractRefType safely extracts ref_type from a content map.
func extractRefType(content map[string]interface{}) string {
	if content == nil {
		return "document"
	}
	if refType, ok := content["ref_type"].(string); ok && refType != "" {
		return refType
	}
	return "document"
}
