package streaming

import (
	mstream "github.com/haowjy/meridian-stream-go"
)

// InterjectionRouter abstracts interjection routing for both HTTP and WS paths.
// Route resolves forwarding chains internally and writes to the active or pending
// interjection buffer based on the current turn phase.
type InterjectionRouter interface {
	Route(turnID, content, mode string) (targetTurnID string, held bool, err error)
	BeginDrain(turnID string) (epoch uint64, drained string, ok bool)
	CompleteDrain(turnID string, epoch uint64, newTurnID string) (late string, ok bool)
	Rollback(turnID string, epoch uint64) bool
	Register(turnID string) *mstream.InMemoryInterjectionBuffer
	Remove(turnID string)
}
