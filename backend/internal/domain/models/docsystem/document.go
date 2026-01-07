package docsystem

import (
	"encoding/json"
	"time"
)

// DocumentMetadata stores format-specific stats in the documents.metadata JSONB column.
//
// We use a map because pgx reliably encodes/decodes JSONB for map[string]interface{} in
// extended protocol mode (see postgres connection config). Typed helpers enforce common shapes.
//
// Example:
//
//	{ "markdown": { "wordCount": 1500 } }
type DocumentMetadata map[string]interface{}

type Document struct {
	ID           string           `json:"id" db:"id"`
	ProjectID    string           `json:"project_id" db:"project_id"`
	FolderID     *string          `json:"folder_id" db:"folder_id"`             // NULL = root level
	Name         string           `json:"name" db:"name"`                       // Display name: "Chapter 5" (no extension)
	Slug         string           `json:"slug" db:"slug"`                       // URL-friendly identifier, unique per project
	Extension    string           `json:"extension" db:"extension"`             // File extension: ".md", ".excalidraw", etc.
	Path         string           `json:"path,omitempty"`                       // Computed display path, not stored in DB
	Content      string           `json:"content" db:"content"`                 // Markdown content (for text-based files)
	AIVersion    *string          `json:"ai_version,omitempty" db:"ai_version"` // AI's suggested version (nullable)
	AIVersionRev int              `json:"ai_version_rev" db:"ai_version_rev"`   // Revision counter for CAS
	Metadata     DocumentMetadata `json:"metadata" db:"metadata"`               // Format-specific stats (JSONB)
	CreatedAt    time.Time        `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time        `json:"updated_at" db:"updated_at"`
	DeletedAt    *time.Time       `json:"deleted_at,omitempty" db:"deleted_at"`
}

// Filename returns the full filename (name + extension)
// Example: Name="Chapter 5", Extension=".md" -> "Chapter 5.md"
func (d *Document) Filename() string {
	return d.Name + d.Extension
}

func (d *Document) EnsureMetadata() {
	if d.Metadata == nil {
		d.Metadata = DocumentMetadata{}
	}
}

// ClearMarkdownMetadata removes the markdown namespace from metadata.
// Use when the document is not in a markdown-family format.
func (d *Document) ClearMarkdownMetadata() {
	if d.Metadata == nil {
		return
	}
	delete(d.Metadata, "markdown")
}

// SetMarkdownWordCount sets metadata.markdown.wordCount.
func (d *Document) SetMarkdownWordCount(wordCount int) {
	d.EnsureMetadata()

	markdown, ok := d.Metadata["markdown"].(map[string]interface{})
	if !ok {
		markdown = map[string]interface{}{}
		d.Metadata["markdown"] = markdown
	}
	markdown["wordCount"] = wordCount
}

// WordCount returns the word count for markdown-family files, or 0 for other formats
// This helper provides backwards compatibility for code that accessed WordCount directly
func (d *Document) WordCount() int {
	if d.Metadata == nil {
		return 0
	}

	markdown, ok := d.Metadata["markdown"].(map[string]interface{})
	if !ok {
		return 0
	}

	raw, ok := markdown["wordCount"]
	if !ok || raw == nil {
		return 0
	}

	switch v := raw.(type) {
	case int:
		return v
	case int32:
		return int(v)
	case int64:
		return int(v)
	case float32:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			return 0
		}
		return int(i)
	}
	return 0
}
