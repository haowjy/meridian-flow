package collab

import "time"

// DocumentTouch records that a turn modified a specific document.
type DocumentTouch struct {
	ID         string    `json:"id"`
	DocumentID string    `json:"document_id"`
	ThreadID   string    `json:"thread_id"`
	TurnID     string    `json:"turn_id"`
	TouchedAt  time.Time `json:"touched_at"`
}
