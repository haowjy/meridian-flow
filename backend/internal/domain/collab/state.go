package collab

import (
	"context"

	"github.com/google/uuid"
)

// DocumentStateStore persists Yjs state plus derived text projections.
type DocumentStateStore interface {
	LoadState(ctx context.Context, docID string) ([]byte, error)
	SaveState(ctx context.Context, docID string, state []byte, content string) error
}

// CheckpointStore persists compacted Yjs checkpoints.
type CheckpointStore interface {
	GetLatest(ctx context.Context, docID string) (state []byte, upToID int64, err error)
	Create(ctx context.Context, docID string, state []byte, upToID int64) error
}

// ProjectedStateBuilder builds Yjs state bytes that include pending proposals
// applied on top of the base document state. Used by the mutation strategy so
// the converter operates on the same content as pending proposals.
type ProjectedStateBuilder interface {
	BuildProjectedState(ctx context.Context, documentID uuid.UUID, userID uuid.UUID) ([]byte, error)
}
