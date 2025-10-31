package utils

import (
	"strings"
	"unicode"
)

// CountWords counts the number of words in a markdown string
func CountWords(markdown string) int {
	// Remove markdown syntax for more accurate word count
	text := cleanMarkdown(markdown)
	
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

func cleanMarkdown(markdown string) string {
	text := markdown
	
	// Remove code blocks
	text = removeCodeBlocks(text)
	
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

func removeCodeBlocks(text string) string {
	// Simple implementation to remove ```...``` blocks
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

