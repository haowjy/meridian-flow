package llm

import (
	"encoding/json"
	"fmt"
	"time"
)

// Content type structs define the JSONB schema for each block type
// These provide type safety and validation for the content field

// ImageContent represents the content structure for image blocks
type ImageContent struct {
	URL      string  `json:"url"`
	MIMEType string  `json:"mime_type"`
	AltText  *string `json:"alt_text,omitempty"`
}

// ReferenceContent represents the content structure for reference blocks
type ReferenceContent struct {
	RefID            string     `json:"ref_id"`
	RefType          string     `json:"ref_type"` // "document", "image", "s3_document"
	VersionTimestamp *time.Time `json:"version_timestamp,omitempty"`
	SelectionStart   *int       `json:"selection_start,omitempty"`
	SelectionEnd     *int       `json:"selection_end,omitempty"`
}

// ToolUseContent represents the content structure for tool_use blocks
type ToolUseContent struct {
	ToolUseID string                 `json:"tool_use_id"`
	ToolName  string                 `json:"tool_name"`
	Input     map[string]interface{} `json:"input"`
}

// ToolResultContent represents the content structure for tool_result blocks
type ToolResultContent struct {
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
}

// ThinkingContent represents the content structure for thinking blocks (optional signature)
type ThinkingContent struct {
	Signature *string `json:"signature,omitempty"`
}

// ValidateContent validates the content map against the expected schema for the given block type
// Returns an error if the content is invalid
func ValidateContent(blockType string, content map[string]interface{}) error {
	if content == nil {
		// null content is only valid for text blocks
		if blockType == BlockTypeText {
			return nil
		}
		// For other types, check if content is required
		switch blockType {
		case BlockTypeThinking:
			// Thinking can have null content (signature is optional)
			return nil
		case BlockTypeToolUse, BlockTypeToolResult, BlockTypeImage, BlockTypeReference, BlockTypePartialReference:
			return fmt.Errorf("%s block requires content", blockType)
		default:
			return fmt.Errorf("unknown block type: %s", blockType)
		}
	}

	switch blockType {
	case BlockTypeText:
		// Text blocks should have null content
		return nil

	case BlockTypeThinking:
		return validateThinkingContent(content)

	case BlockTypeToolUse:
		return validateToolUseContent(content)

	case BlockTypeToolResult:
		return validateToolResultContent(content)

	case BlockTypeImage:
		return validateImageContent(content)

	case BlockTypeReference, BlockTypePartialReference:
		return validateReferenceContent(content)

	default:
		return fmt.Errorf("unknown block type: %s", blockType)
	}
}

// validateThinkingContent validates thinking block content
func validateThinkingContent(content map[string]interface{}) error {
	// Thinking content is optional (just signature field)
	// No required fields, so just check it can be marshaled to the struct
	var thinking ThinkingContent
	return mapToStruct(content, &thinking)
}

// validateToolUseContent validates tool_use block content
func validateToolUseContent(content map[string]interface{}) error {
	var toolUse ToolUseContent
	if err := mapToStruct(content, &toolUse); err != nil {
		return fmt.Errorf("invalid tool_use content structure: %w", err)
	}

	// Validate required fields
	if toolUse.ToolUseID == "" {
		return fmt.Errorf("tool_use_id is required")
	}
	if toolUse.ToolName == "" {
		return fmt.Errorf("tool_name is required")
	}
	if toolUse.Input == nil {
		return fmt.Errorf("input is required")
	}

	return nil
}

// validateToolResultContent validates tool_result block content
func validateToolResultContent(content map[string]interface{}) error {
	var toolResult ToolResultContent
	if err := mapToStruct(content, &toolResult); err != nil {
		return fmt.Errorf("invalid tool_result content structure: %w", err)
	}

	// Validate required fields
	if toolResult.ToolUseID == "" {
		return fmt.Errorf("tool_use_id is required")
	}

	return nil
}

// validateImageContent validates image block content
func validateImageContent(content map[string]interface{}) error {
	var image ImageContent
	if err := mapToStruct(content, &image); err != nil {
		return fmt.Errorf("invalid image content structure: %w", err)
	}

	// Validate required fields
	if image.URL == "" {
		return fmt.Errorf("url is required")
	}
	if image.MIMEType == "" {
		return fmt.Errorf("mime_type is required")
	}

	return nil
}

// validateReferenceContent validates reference/partial_reference block content
func validateReferenceContent(content map[string]interface{}) error {
	var ref ReferenceContent
	if err := mapToStruct(content, &ref); err != nil {
		return fmt.Errorf("invalid reference content structure: %w", err)
	}

	// Validate required fields
	if ref.RefID == "" {
		return fmt.Errorf("ref_id is required")
	}
	if ref.RefType == "" {
		return fmt.Errorf("ref_type is required")
	}

	// Validate ref_type is one of allowed values
	validRefTypes := map[string]bool{
		"document":     true,
		"image":        true,
		"s3_document":  true,
	}
	if !validRefTypes[ref.RefType] {
		return fmt.Errorf("ref_type must be one of: document, image, s3_document")
	}

	return nil
}

// mapToStruct converts a map to a struct using JSON marshaling
// This is a helper for validating map structures against typed structs
func mapToStruct(m map[string]interface{}, target interface{}) error {
	// Marshal the map to JSON
	jsonBytes, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("failed to marshal map: %w", err)
	}

	// Unmarshal into the target struct
	if err := json.Unmarshal(jsonBytes, target); err != nil {
		return fmt.Errorf("failed to unmarshal to struct: %w", err)
	}

	return nil
}
