package llm

import (
	"context"
)

// MessageBuilder builds LLM messages from conversation history.
// The caller is responsible for loading the turn path and blocks using TurnNavigator/TurnReader.
type MessageBuilder interface {
	// BuildMessages converts a turn path (with blocks already loaded) to LLM messages
	// suitable for provider requests. The path should be ordered from oldest to newest.
	// The caller must load turn blocks before calling this method.
	//
	// Bookmark awareness:
	//   - If the path contains a compaction turn, all turns before it are skipped and
	//     the compaction summary is injected as a leading user context message.
	//   - If the path contains a collapse marker, tool_result blocks before the marker
	//     are substituted with their collapsed_content (if set).
	//   - When no bookmark turns are present, output is identical to the pre-bookmark
	//     implementation (regression-safe).
	BuildMessages(ctx context.Context, path []Turn) ([]Message, error)
}

// --- Bookmark helpers used by MessageBuilder implementations ---

// HasBookmarkTurns returns true if any turn in path is a compaction or collapse marker.
// Used as a fast short-circuit: if false, the no-bookmark (legacy) code path is taken.
func HasBookmarkTurns(path []Turn) bool {
	for i := range path {
		if path[i].IsBookmarkTurn() {
			return true
		}
	}
	return false
}

// FindLastCompactionTurn returns the index of the most-recent compaction turn in path,
// or -1 if none exists. Scans from the end so the most-recent bookmark wins.
func FindLastCompactionTurn(path []Turn) int {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i].IsCompactionTurn() {
			return i
		}
	}
	return -1
}

// FindLastCollapseMarker returns the index of the most-recent collapse marker turn
// in path, or -1 if none exists.
func FindLastCollapseMarker(path []Turn) int {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i].IsCollapseMarker() {
			return i
		}
	}
	return -1
}

// ExtractCompactionSummary returns the text content of the first text block in a
// compaction turn. Returns "" if the turn has no text blocks or the content is empty.
// The summary is later injected by the MessageBuilder as a leading context message.
func ExtractCompactionSummary(turn Turn) string {
	for _, block := range turn.Blocks {
		if block.BlockType == BlockTypeText && block.TextContent != nil && *block.TextContent != "" {
			return *block.TextContent
		}
	}
	return ""
}
