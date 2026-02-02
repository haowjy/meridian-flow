package docsystem

import "time"

// ProjectTree is the service-layer representation of a project's folder/document hierarchy.
//
// This is intentionally not a transport DTO:
// - no JSON tags
// - no frontend-specific fields
// Handler layer is responsible for mapping this to API response DTOs.
type ProjectTree struct {
	Folders   []*TreeFolder
	Documents []TreeDocument
}

// TreeFolder is a folder node in the project tree.
type TreeFolder struct {
	ID        string
	ProjectID string
	FolderID  *string // Parent folder ID (nil = root)
	Name      string
	Path      string  // Normalized path (e.g., "Characters/Heroes")
	IsHidden  bool    // Hidden folders excluded from tree by default (e.g., .meridian)
	CreatedAt time.Time
	UpdatedAt time.Time

	Folders   []*TreeFolder
	Documents []TreeDocument
}

// TreeDocument is a document node in the project tree (metadata only, no content).
type TreeDocument struct {
	ID        string
	ProjectID string
	FolderID  *string // Parent folder ID (nil = root)
	Name      string
	Extension string
	Path      string // Normalized path with extension (e.g., "Characters/Heroes/Aria.md")
	UpdatedAt time.Time
}
