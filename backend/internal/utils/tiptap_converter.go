package utils

import (
	"fmt"
	"strings"
)

// ConvertTipTapToMarkdown converts TipTap JSON to Markdown
func ConvertTipTapToMarkdown(tiptapJSON map[string]interface{}) (string, error) {
	if tiptapJSON == nil {
		return "", nil
	}

	content, ok := tiptapJSON["content"].([]interface{})
	if !ok {
		return "", nil
	}

	var markdown strings.Builder
	for _, node := range content {
		nodeMap, ok := node.(map[string]interface{})
		if !ok {
			continue
		}
		convertNode(&markdown, nodeMap, 0)
	}

	return strings.TrimSpace(markdown.String()), nil
}

func convertNode(builder *strings.Builder, node map[string]interface{}, level int) {
	nodeType, _ := node["type"].(string)

	switch nodeType {
	case "heading":
		convertHeading(builder, node)
	case "paragraph":
		convertParagraph(builder, node)
	case "bulletList":
		convertBulletList(builder, node)
	case "orderedList":
		convertOrderedList(builder, node)
	case "listItem":
		convertListItem(builder, node, level)
	case "codeBlock":
		convertCodeBlock(builder, node)
	case "blockquote":
		convertBlockquote(builder, node)
	case "horizontalRule":
		builder.WriteString("---\n\n")
	case "hardBreak":
		builder.WriteString("  \n")
	default:
		// For unknown types, try to process content
		if content, ok := node["content"].([]interface{}); ok {
			for _, child := range content {
				if childNode, ok := child.(map[string]interface{}); ok {
					convertNode(builder, childNode, level)
				}
			}
		}
	}
}

func convertHeading(builder *strings.Builder, node map[string]interface{}) {
	attrs, _ := node["attrs"].(map[string]interface{})
	level, _ := attrs["level"].(float64)
	
	// Add heading markers
	for i := 0; i < int(level); i++ {
		builder.WriteString("#")
	}
	builder.WriteString(" ")
	
	// Process content
	if content, ok := node["content"].([]interface{}); ok {
		processInlineContent(builder, content)
	}
	builder.WriteString("\n\n")
}

func convertParagraph(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		processInlineContent(builder, content)
	}
	builder.WriteString("\n\n")
}

func convertBulletList(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, item := range content {
			if itemNode, ok := item.(map[string]interface{}); ok {
				builder.WriteString("- ")
				convertListItem(builder, itemNode, 0)
			}
		}
	}
	builder.WriteString("\n")
}

func convertOrderedList(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for i, item := range content {
			if itemNode, ok := item.(map[string]interface{}); ok {
				builder.WriteString(fmt.Sprintf("%d. ", i+1))
				convertListItem(builder, itemNode, 0)
			}
		}
	}
	builder.WriteString("\n")
}

func convertListItem(builder *strings.Builder, node map[string]interface{}, level int) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				childType, _ := childNode["type"].(string)
				if childType == "paragraph" {
					if childContent, ok := childNode["content"].([]interface{}); ok {
						processInlineContent(builder, childContent)
					}
					builder.WriteString("\n")
				} else {
					convertNode(builder, childNode, level+1)
				}
			}
		}
	}
}

func convertCodeBlock(builder *strings.Builder, node map[string]interface{}) {
	attrs, _ := node["attrs"].(map[string]interface{})
	language, _ := attrs["language"].(string)
	
	builder.WriteString("```")
	if language != "" {
		builder.WriteString(language)
	}
	builder.WriteString("\n")
	
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				if text, ok := childNode["text"].(string); ok {
					builder.WriteString(text)
				}
			}
		}
	}
	
	builder.WriteString("\n```\n\n")
}

func convertBlockquote(builder *strings.Builder, node map[string]interface{}) {
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childNode, ok := child.(map[string]interface{}); ok {
				builder.WriteString("> ")
				convertNode(builder, childNode, 0)
			}
		}
	}
}

func processInlineContent(builder *strings.Builder, content []interface{}) {
	for _, item := range content {
		node, ok := item.(map[string]interface{})
		if !ok {
			continue
		}

		nodeType, _ := node["type"].(string)
		if nodeType == "text" {
			text, _ := node["text"].(string)
			
			// Apply marks (bold, italic, code, etc.)
			if marks, ok := node["marks"].([]interface{}); ok {
				text = applyMarks(text, marks)
			}
			
			builder.WriteString(text)
		} else if nodeType == "hardBreak" {
			builder.WriteString("  \n")
		}
	}
}

func applyMarks(text string, marks []interface{}) string {
	var result = text
	var wrappers []string
	
	for _, mark := range marks {
		markMap, ok := mark.(map[string]interface{})
		if !ok {
			continue
		}
		
		markType, _ := markMap["type"].(string)
		switch markType {
		case "bold":
			wrappers = append([]string{"**"}, wrappers...)
		case "italic":
			wrappers = append([]string{"*"}, wrappers...)
		case "code":
			wrappers = append([]string{"`"}, wrappers...)
		case "strike":
			wrappers = append([]string{"~~"}, wrappers...)
		}
	}
	
	// Wrap text with all marks
	for _, wrapper := range wrappers {
		result = wrapper + result + wrapper
	}
	
	return result
}

