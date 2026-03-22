package collab

import (
	"context"

	"github.com/google/uuid"
)

// DocumentStateManager applies Yjs updates to the authoritative in-memory document runtime.
type DocumentStateManager interface {
	ApplyUpdate(ctx context.Context, documentID uuid.UUID, update []byte, origin string) error
	GetStateSnapshot(ctx context.Context, documentID uuid.UUID) ([]byte, bool, error)
	// GetCurrentState returns the current Yjs state for a document. Unlike GetStateSnapshot,
	// this always returns state - from the active in-memory session if one exists, otherwise
	// by loading from persisted storage.
	GetCurrentState(ctx context.Context, documentID uuid.UUID) ([]byte, error)
	CreateAITurnBookmark(ctx context.Context, documentID uuid.UUID, turnID uuid.UUID) error
}
