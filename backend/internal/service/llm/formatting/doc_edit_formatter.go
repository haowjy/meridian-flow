package formatting

import (
	"fmt"
	"strings"
)

// TextEditorFormatter transforms str_replace_based_edit_tool results for LLM consumption.
//
// View results (command: "view"):
//   - Document: converted to human-readable text with line numbers and header
//   - Folder: converted to indented listing with word counts
//
// Edit results (str_replace, create, insert): success passed through unchanged
// Error results: compressed to minimal strings ("NO_MATCH", "NOT_FOUND:/path", etc.)
type TextEditorFormatter struct{}

// Format transforms a text editor result for LLM consumption.
// Detects result type by "type" field and applies appropriate formatting.
func (f *TextEditorFormatter) Format(result interface{}) interface{} {
	resultMap, ok := result.(map[string]interface{})
	if !ok {
		return result
	}

	// Error responses have error_code — compress to minimal string
	if _, hasErr := resultMap["error_code"].(string); hasErr {
		if formatted, ok := TryFormatToolError(resultMap); ok {
			return formatted
		}
		return result
	}

	// Route by result type for view results
	resultType, _ := resultMap["type"].(string)
	switch resultType {
	case "document":
		return f.formatDocument(resultMap)
	case "folder":
		return f.formatFolder(resultMap)
	default:
		// str_replace, create, insert successes — pass through unchanged
		return result
	}
}

// formatDocument converts a document view result to human-readable text.
//
// Output format:
//
//	/Chapter 1.md (42 lines)
//	1: Once upon a time...
//	2: In a land far away...
func (f *TextEditorFormatter) formatDocument(result map[string]interface{}) interface{} {
	path, _ := result["path"].(string)
	content, _ := result["content"].(string)

	// Build header: path (N lines)
	var header strings.Builder
	header.WriteString(path)

	// Line count from total_lines field (set by TextEditorTool) or count from content
	totalLines := toInt(result["total_lines"])
	if totalLines > 0 {
		fmt.Fprintf(&header, " (%d lines)", totalLines)
	}

	// Partial range indicator
	if viewRange, ok := result["view_range"].([]interface{}); ok && len(viewRange) == 2 {
		start := toInt(viewRange[0])
		end := toInt(viewRange[1])
		if start > 0 && end > 0 && (start > 1 || end < totalLines) {
			fmt.Fprintf(&header, " viewing lines %d-%d", start, end)
		}
	} else if viewRange, ok := result["view_range"].([]int); ok && len(viewRange) == 2 {
		if viewRange[0] > 1 || viewRange[1] < totalLines {
			fmt.Fprintf(&header, " viewing lines %d-%d", viewRange[0], viewRange[1])
		}
	}

	// Truncation warning
	if wasTruncated, ok := result["was_truncated"].(bool); ok && wasTruncated {
		header.WriteString(" [TRUNCATED]")
	}

	// Content already has line numbers from formatDocumentWithLineNumbers (text_editor.go)
	if content == "" {
		return header.String()
	}
	return header.String() + "\n" + content
}

// formatFolder converts a folder view result to a simple indented listing.
//
// Output format:
//
//	/Short-Stories
//	  Drafts/
//	  Storm Magic Ideas.md (200 words)
func (f *TextEditorFormatter) formatFolder(result map[string]interface{}) interface{} {
	path, _ := result["path"].(string)
	if path == "" {
		path = "/"
	}

	var sb strings.Builder
	sb.WriteString(path)

	// Folders first (with / suffix)
	if folders, ok := result["folders"].([]interface{}); ok {
		for _, item := range folders {
			if folder, ok := item.(map[string]interface{}); ok {
				name, _ := folder["name"].(string)
				sb.WriteString("\n  ")
				sb.WriteString(name)
				sb.WriteString("/")
			}
		}
	}

	// Then documents (with word count)
	if documents, ok := result["documents"].([]interface{}); ok {
		for _, item := range documents {
			if doc, ok := item.(map[string]interface{}); ok {
				name, _ := doc["name"].(string)
				sb.WriteString("\n  ")
				sb.WriteString(name)

				wordCount := toInt(doc["word_count"])
				if wordCount > 0 {
					fmt.Fprintf(&sb, " (%d words)", wordCount)
				}
			}
		}
	}

	return sb.String()
}

// toInt safely converts interface{} to int. Handles float64 (JSON) and int.
func toInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

// DocEditFormatter is an alias for TextEditorFormatter for backward compatibility.
// Deprecated: Use TextEditorFormatter instead.
type DocEditFormatter = TextEditorFormatter
