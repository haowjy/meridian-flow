package config

const (
	// MaxProjectNameLength is the maximum length for project names.
	// Limited to 255 to fit in PostgreSQL VARCHAR(255) and provide
	// reasonable UX (names should be short and descriptive).
	MaxProjectNameLength = 255

	// MaxDocumentNameLength is the maximum length for document names.
	// Limited to 255 to fit in PostgreSQL VARCHAR(255) and provide
	// reasonable UX (names should be short and descriptive).
	MaxDocumentNameLength = 255

	// MaxFolderNameLength is the maximum length for folder names.
	// Same as document names for consistency.
	MaxFolderNameLength = 255

	// MaxChatTitleLength is the maximum length for chat titles.
	// Limited to 255 to fit in PostgreSQL VARCHAR(255) and provide
	// reasonable UX (titles should be short and descriptive).
	MaxChatTitleLength = 255

	// MaxDocumentPathLength is the maximum length for full document paths.
	// Set to 500 to allow paths like "A/B/C/D/E/document" where each
	// segment can be up to 100 characters. Longer paths indicate
	// overly deep hierarchies (anti-pattern).
	MaxDocumentPathLength = 500
)
