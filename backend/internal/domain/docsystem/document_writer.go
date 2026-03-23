package docsystem

import "context"

// DocumentWriter defines write operations for documents.
type DocumentWriter interface {
	Create(ctx context.Context, doc *Document) error
	Update(ctx context.Context, doc *Document) error
	Delete(ctx context.Context, id, projectID string) (*Document, error)
	DeleteAllByProject(ctx context.Context, projectID string, skipSystemFolders bool) error
}
