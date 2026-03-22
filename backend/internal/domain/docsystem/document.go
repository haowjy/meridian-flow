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
	ID                   string           `json:"id" db:"id"`
	ProjectID            string           `json:"project_id" db:"project_id"`
	FolderID             *string          `json:"folder_id" db:"folder_id"` // NULL = root level
	Name                 string           `json:"name" db:"name"`           // Display name: "Chapter 5" (no extension)
	Extension            string           `json:"extension" db:"extension"` // File extension: ".md", ".excalidraw", etc.
	Description          *string          `json:"description,omitempty" db:"description"`
	Autoapply            *bool            `json:"autoapply,omitempty" db:"autoapply"`
	FileType             string           `json:"file_type" db:"file_type"`
	StorageURL           *string          `json:"storage_url,omitempty" db:"storage_url"`
	MimeType             *string          `json:"mime_type,omitempty" db:"mime_type"`
	SizeBytes            *int64           `json:"size_bytes,omitempty" db:"size_bytes"`
	Path                 string           `json:"path,omitempty"`                                               // Computed display path with extension, not stored in DB
	PendingProposalCount int              `json:"pending_proposal_count,omitempty" db:"pending_proposal_count"` // Metadata-only tree field: count of proposals with status='pending'
	Content              string           `json:"content" db:"content"`                                         // Markdown content (for text-based files)
	Metadata             DocumentMetadata `json:"metadata" db:"metadata"`                                       // Format-specific stats (JSONB)
	CreatedAt            time.Time        `json:"created_at" db:"created_at"`
	UpdatedAt            time.Time        `json:"updated_at" db:"updated_at"`
	DeletedAt            *time.Time       `json:"deleted_at,omitempty" db:"deleted_at"`
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

func (d *Document) EnsureFileType() {
	if d.FileType == "" {
		d.FileType = string(FileTypeFromExtension(d.Extension))
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
