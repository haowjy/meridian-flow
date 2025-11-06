package services

// ContentAnalyzer handles content analysis operations
type ContentAnalyzer interface {
	// CountWords counts words in markdown content
	CountWords(markdown string) int

	// CleanMarkdown removes markdown syntax from content
	CleanMarkdown(markdown string) string
}
