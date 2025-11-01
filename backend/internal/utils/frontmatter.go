package utils

import (
	"bytes"
	"errors"
	"fmt"

	"gopkg.in/yaml.v3"
)

// DocumentMetadata represents parsed frontmatter metadata for import
type DocumentMetadata struct {
	Path *string  // Optional: full folder path (e.g., "Characters/Aria Moonwhisper"). If nil, derived from file path
	Name *string  // Optional: document name if different from filename
	Tags []string // Future feature
}

// ParseFrontmatter parses YAML frontmatter and markdown content from a file
// Expected format:
// ---
// path: Characters/Aria
// name: Hero/Villain Arc
// ---
// # Markdown content here
func ParseFrontmatter(content []byte) (map[string]interface{}, string, error) {
	// Check for frontmatter delimiters
	if !bytes.HasPrefix(content, []byte("---\n")) && !bytes.HasPrefix(content, []byte("---\r\n")) {
		return nil, "", errors.New("missing frontmatter: file must start with '---'")
	}

	// Find the closing delimiter
	var closingDelim int
	lines := bytes.Split(content, []byte("\n"))

	// Skip the opening "---" line
	for i := 1; i < len(lines); i++ {
		line := bytes.TrimSpace(lines[i])
		if bytes.Equal(line, []byte("---")) {
			closingDelim = i
			break
		}
	}

	if closingDelim == 0 {
		return nil, "", errors.New("missing closing frontmatter delimiter '---'")
	}

	// Extract YAML content (between the delimiters)
	yamlContent := bytes.Join(lines[1:closingDelim], []byte("\n"))

	// Parse YAML
	var metadata map[string]interface{}
	if err := yaml.Unmarshal(yamlContent, &metadata); err != nil {
		return nil, "", fmt.Errorf("failed to parse YAML frontmatter: %w", err)
	}

	// Extract markdown content (everything after closing delimiter)
	markdownLines := lines[closingDelim+1:]
	markdownContent := string(bytes.Join(markdownLines, []byte("\n")))

	return metadata, markdownContent, nil
}

// ValidateImportMetadata validates frontmatter metadata and converts to DocumentMetadata
func ValidateImportMetadata(metadata map[string]interface{}) (*DocumentMetadata, error) {
	if metadata == nil {
		// No metadata is fine - path and name will be derived from filesystem
		return &DocumentMetadata{}, nil
	}

	// Extract optional field: path
	var path *string
	if pathVal, exists := metadata["path"]; exists {
		if pathStr, ok := pathVal.(string); ok && pathStr != "" {
			path = &pathStr
		} else if exists {
			return nil, errors.New("frontmatter field 'path' must be a non-empty string")
		}
	}

	// Extract optional field: name
	var name *string
	if nameVal, exists := metadata["name"]; exists {
		if nameStr, ok := nameVal.(string); ok && nameStr != "" {
			name = &nameStr
		} else if exists {
			return nil, errors.New("frontmatter field 'name' must be a non-empty string")
		}
	}

	// Extract optional field: tags (future feature)
	var tags []string
	if tagsVal, exists := metadata["tags"]; exists {
		if tagsList, ok := tagsVal.([]interface{}); ok {
			for _, tag := range tagsList {
				if tagStr, ok := tag.(string); ok {
					tags = append(tags, tagStr)
				}
			}
		}
	}

	return &DocumentMetadata{
		Path: path,
		Name: name,
		Tags: tags,
	}, nil
}
