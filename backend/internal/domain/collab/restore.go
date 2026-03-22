package collab

import (
	"context"

	"github.com/google/uuid"
)

type RestoreResult struct {
	AffectedDocumentIDs []uuid.UUID
}

type RestoreService interface {
	RestoreTurn(ctx context.Context, userID string, turnID uuid.UUID) (*RestoreResult, error)
	UndoRestore(ctx context.Context, userID string, turnID uuid.UUID) (*RestoreResult, error)
}
