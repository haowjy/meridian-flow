package llm

import (
	"context"
	"fmt"

	llmRepo "meridian/internal/domain/repositories/llm"
)

// ThreadValidator validates that threads are not soft-deleted
// before allowing operations on them or their turns
type ThreadValidator struct {
	threadRepo llmRepo.ThreadRepository
}

// NewThreadValidator creates a new thread validator
func NewThreadValidator(threadRepo llmRepo.ThreadRepository) *ThreadValidator {
	return &ThreadValidator{
		threadRepo: threadRepo,
	}
}

// ValidateThread ensures a thread exists and is not soft-deleted
// Returns domain.ErrNotFound if thread is deleted or doesn't exist
func (v *ThreadValidator) ValidateThread(ctx context.Context, threadID, userID string) error {
	_, err := v.threadRepo.GetThread(ctx, threadID, userID)
	if err != nil {
		return fmt.Errorf("invalid thread: %w", err)
	}
	return nil
}
