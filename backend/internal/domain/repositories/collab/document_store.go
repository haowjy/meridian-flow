package collab

import "context"

// DocumentStoreRepository is persistence storage for Yjs binary state.
type DocumentStoreRepository interface {
	LoadState(ctx context.Context, docID string) ([]byte, error)
	SaveState(ctx context.Context, docID string, state []byte, content string, aiContent string) error
	SaveSnapshot(
		ctx context.Context,
		docID string,
		state []byte,
		snapshotType string,
		name *string,
		createdByUserID *string,
	) error
}
