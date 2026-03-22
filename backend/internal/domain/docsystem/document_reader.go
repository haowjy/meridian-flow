package docsystem

import "context"

// DocumentReader defines read-only document access.
type DocumentReader interface {
	GetByID(ctx context.Context, id, projectID string) (*Document, error)
	GetByIDOnly(ctx context.Context, id string) (*Document, error)
	GetByPath(ctx context.Context, path string, projectID string) (*Document, error)
	ListByFolder(ctx context.Context, folderID *string, projectID string) ([]Document, error)
	GetAllMetadataByProject(ctx context.Context, projectID string) ([]Document, error)
}
