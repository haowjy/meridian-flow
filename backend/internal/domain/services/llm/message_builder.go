package llm

import (
	"context"

	"meridian/internal/domain/models/llm"
)

// MessageBuilder builds LLM messages from conversation history.
// The caller is responsible for loading the turn path and blocks using TurnNavigator/TurnReader.
type MessageBuilder interface {
	// BuildMessages converts a turn path (with blocks already loaded) to LLM messages
	// suitable for provider requests. The path should be ordered from oldest to newest.
	// The caller must load turn blocks before calling this method.
	BuildMessages(ctx context.Context, path []llm.Turn) ([]Message, error)
}
