package docsystem

import "context"

// DocumentSearcher defines search operations for documents.
type DocumentSearcher interface {
	SearchDocuments(ctx context.Context, options *SearchOptions) (*SearchResults, error)
}
