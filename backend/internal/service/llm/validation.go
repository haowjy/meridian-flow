package llm

import (
	"context"
	"fmt"

	llmRepo "meridian/internal/domain/repositories/llm"
)

// ChatValidator validates that chats are not soft-deleted
// before allowing operations on them or their turns
type ChatValidator struct {
	chatRepo llmRepo.ChatRepository
}

// NewChatValidator creates a new chat validator
func NewChatValidator(chatRepo llmRepo.ChatRepository) *ChatValidator {
	return &ChatValidator{
		chatRepo: chatRepo,
	}
}

// ValidateChat ensures a chat exists and is not soft-deleted
// Returns domain.ErrNotFound if chat is deleted or doesn't exist
func (v *ChatValidator) ValidateChat(ctx context.Context, chatID, userID string) error {
	_, err := v.chatRepo.GetChat(ctx, chatID, userID)
	if err != nil {
		return fmt.Errorf("invalid chat: %w", err)
	}
	return nil
}
