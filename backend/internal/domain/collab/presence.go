package collab

import "context"

// DocumentPresenceTracker reports whether a document has at least one active subscriber.
type DocumentPresenceTracker interface {
	HasActiveSubscribers(documentID string) bool
}

// StatusMirror mirrors _proposal_status Y.Map values into proposal rows.
type StatusMirror interface {
	// OnStatusChange handles one _proposal_status key delta.
	// newStatus == nil means the key was deleted and should map to pending.
	OnStatusChange(ctx context.Context, proposalID string, newStatus *string) error
	// ReconcileAll repairs drift for one document by reconciling all proposal rows
	// against the current _proposal_status map snapshot.
	ReconcileAll(ctx context.Context, documentID string, statusMap map[string]string) error
}
