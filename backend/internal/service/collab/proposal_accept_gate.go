package collab

import (
	"sync"

	"github.com/google/uuid"
)

// proposalAcceptGate serializes acceptance mutations per document ID.
// Different documents can proceed concurrently.
type proposalAcceptGate struct {
	locks sync.Map // map[uuid.UUID]*sync.Mutex
}

func newProposalAcceptGate() *proposalAcceptGate {
	return &proposalAcceptGate{}
}

func (g *proposalAcceptGate) WithDocument(documentID uuid.UUID, fn func() error) error {
	lock := g.lockFor(documentID)
	lock.Lock()
	defer lock.Unlock()
	return fn()
}

func (g *proposalAcceptGate) lockFor(documentID uuid.UUID) *sync.Mutex {
	if lock, ok := g.locks.Load(documentID); ok {
		return lock.(*sync.Mutex)
	}
	newLock := &sync.Mutex{}
	actual, _ := g.locks.LoadOrStore(documentID, newLock)
	return actual.(*sync.Mutex)
}
