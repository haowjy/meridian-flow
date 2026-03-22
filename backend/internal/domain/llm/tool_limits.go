package llm

import "context"

// ToolLimitResolver resolves tool round limits for users.
type ToolLimitResolver interface {
	GetToolRoundLimit(ctx context.Context, userID string) (int, error)
}
