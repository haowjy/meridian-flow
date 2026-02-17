package collab

import (
	"sync"

	"github.com/google/uuid"
)

// proposalDocumentGate serializes operations per document while allowing
// different documents to proceed concurrently.
//
// Bounded growth: The locks sync.Map grows by one *sync.Mutex per unique document
// that has ever had a create operation. Each entry is negligible (~pointer + mutex).
// For Meridian's expected workload (single-writer platform with bounded document
// counts), this is well within acceptable limits. If document cardinality becomes
// a concern, consider a striped lock pool keyed by document ID hash.
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
