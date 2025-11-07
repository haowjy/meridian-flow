package docsystem

import (
	"strings"
	"unicode"

	docsysSvc "meridian/internal/domain/services/docsystem"
)

type contentAnalyzerService struct{}

// NewContentAnalyzer creates a new content analyzer service
func NewContentAnalyzer() docsysSvc.ContentAnalyzer {
	return &contentAnalyzerService{}
}

// CountWords counts the number of words in markdown text
func (s *contentAnalyzerService) CountWords(markdown string) int {
	// Remove markdown syntax for more accurate word count
	text := s.CleanMarkdown(markdown)

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

// CleanMarkdown removes markdown syntax from text
func (s *contentAnalyzerService) CleanMarkdown(markdown string) string {
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
		// Remove bullet points and numbered lists
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "- ") {
			line = strings.TrimPrefix(line, "- ")
		} else if strings.HasPrefix(line, "* ") {
			line = strings.TrimPrefix(line, "* ")
		}
		// Remove numbered list markers (e.g., "1. ", "2. ")
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

// removeCodeBlocks removes ```...``` code blocks from text
func (s *contentAnalyzerService) removeCodeBlocks(text string) string {
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
