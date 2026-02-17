package collab

import (
	"sync"

	"github.com/google/uuid"
)

// proposalDocumentGate serializes operations per document while allowing
// different documents to proceed concurrently.
type proposalDocumentGate struct {
	locks sync.Map // map[uuid.UUID]*sync.Mutex
}

func newProposalDocumentGate() *proposalDocumentGate {
	return &proposalDocumentGate{}
}

func (g *proposalDocumentGate) WithDocument(documentID uuid.UUID, fn func() error) error {
	lock := g.lockFor(documentID)
	lock.Lock()
	defer lock.Unlock()
	return fn()
}

func (g *proposalDocumentGate) lockFor(documentID uuid.UUID) *sync.Mutex {
	if lock, ok := g.locks.Load(documentID); ok {
		return lock.(*sync.Mutex)
	}
	newLock := &sync.Mutex{}
	actual, _ := g.locks.LoadOrStore(documentID, newLock)
	return actual.(*sync.Mutex)
}
