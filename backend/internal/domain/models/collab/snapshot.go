package collab

import "time"

// Snapshot represents a point-in-time capture of document Yjs state.
type Snapshot struct {
	ID              string    `json:"id"`
	DocumentID      string    `json:"document_id"`
	SnapshotType    string    `json:"snapshot_type"`
	Name            *string   `json:"name,omitempty"`
	CreatedByUserID *string   `json:"created_by_user_id,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

// SnapshotWithState includes the binary Yjs state (used for restore operations).
type SnapshotWithState struct {
	Snapshot
	YjsState []byte `json:"-"`
}
