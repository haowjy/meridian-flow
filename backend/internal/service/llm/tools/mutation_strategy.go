package tools

import "context"

// DocumentMutationStrategy defines how AI edits are persisted.
// The only implementation is CollabProposalStrategy, which creates a proposal
// with Yjs update bytes and broadcasts it via WebSocket.
type DocumentMutationStrategy interface {
	Apply(ctx context.Context, input MutationInput) (*MutationResult, error)
}

// MutationInput captures the data needed by any mutation strategy.
type MutationInput struct {
	DocumentID  string // document UUID
	UserID      string // user performing the edit
	Path        string // file path in project
	Base        string // current document content (before edit)
	NewContent  string // content after edit
	OldContent  string // original text being replaced (for targeted Yjs diffs)
	ReplContent string // replacement text (for targeted Yjs diffs)
	Description string // human-readable edit description
}

// MutationResult is returned to the tool layer after a strategy completes.
type MutationResult struct {
	Message string                 // success message for the LLM
	Extra   map[string]interface{} // additional fields (proposal_id, etc.)
}
