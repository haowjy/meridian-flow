package tools

import "context"

// Thread context propagation for tool execution.
// When the LLM invokes tools (e.g., document edits), the tool executor needs to know
// which thread/turn/user triggered the action for provenance tracking (collab proposals).

// unexported key types to avoid context key collisions (Go best practice)
type threadIDKey struct{}
type turnIDKey struct{}
type userIDKey struct{}

// InjectThreadContext stores thread, turn, and user IDs into the context.
// Called by the streaming tool executor before parallel tool execution so that
// tools (like the future CollabProposalStrategy) can attribute edits to the
// originating thread conversation.
func InjectThreadContext(ctx context.Context, threadID, turnID, userID string) context.Context {
	ctx = context.WithValue(ctx, threadIDKey{}, threadID)
	ctx = context.WithValue(ctx, turnIDKey{}, turnID)
	ctx = context.WithValue(ctx, userIDKey{}, userID)
	return ctx
}

// ExtractThreadContext retrieves thread, turn, and user IDs from the context.
// Returns ok=false if any of the three values are missing or empty.
func ExtractThreadContext(ctx context.Context) (threadID, turnID, userID string, ok bool) {
	threadID, _ = ctx.Value(threadIDKey{}).(string)
	turnID, _ = ctx.Value(turnIDKey{}).(string)
	userID, _ = ctx.Value(userIDKey{}).(string)

	if threadID == "" || turnID == "" || userID == "" {
		return "", "", "", false
	}
	return threadID, turnID, userID, true
}
