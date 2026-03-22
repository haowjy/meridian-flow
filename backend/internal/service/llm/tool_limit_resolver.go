package llm

import "context"

// ConfigToolLimitResolver returns a static limit for all users.
// Used when no tier system is in place - all users get the same generous limit.
type ConfigToolLimitResolver struct {
	defaultLimit int
}

// NewConfigToolLimitResolver creates a resolver that returns the same limit for all users.
func NewConfigToolLimitResolver(defaultLimit int) *ConfigToolLimitResolver {
	return &ConfigToolLimitResolver{defaultLimit: defaultLimit}
}

// GetToolRoundLimit returns the configured default limit for any user.
func (r *ConfigToolLimitResolver) GetToolRoundLimit(ctx context.Context, userID string) (int, error) {
	return r.defaultLimit, nil
}
