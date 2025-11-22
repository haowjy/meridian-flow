package formatting

import (
	"fmt"
	"strings"
)

// MetadataRenderer renders metadata for a document or folder item.
// Implementations can be added to extend what metadata is shown without
// modifying existing code (Open/Closed Principle).
type MetadataRenderer interface {
	Render(item map[string]interface{}) string
}

// WordCountRenderer renders word count metadata for documents.
type WordCountRenderer struct{}

// Render returns a formatted word count string like "(277 words)".
// Returns empty string if word_count is not present or not a number.
func (r *WordCountRenderer) Render(item map[string]interface{}) string {
	wc, ok := item["word_count"].(float64)
	if !ok {
		return ""
	}

	count := int(wc)
	if count == 0 {
		return ""
	}

	return fmt.Sprintf("(%d words)", count)
}

// CombineMetadata applies multiple metadata renderers and combines their output.
// Returns a single string with all non-empty metadata separated by spaces.
// This allows easy composition of multiple metadata fields.
func CombineMetadata(renderers []MetadataRenderer, item map[string]interface{}) string {
	var parts []string

	for _, renderer := range renderers {
		if result := renderer.Render(item); result != "" {
			parts = append(parts, result)
		}
	}

	return strings.Join(parts, " ")
}
