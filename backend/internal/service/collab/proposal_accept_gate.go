package collab

import (
	"fmt"
	"sync"

	"github.com/google/uuid"

	"meridian/internal/domain"
)

// proposalAcceptGate serializes acceptance mutations per document ID and bounds
// same-document pending operations (in-flight + waiting).
type proposalAcceptGate struct {
	mu         sync.Mutex
	locks      map[uuid.UUID]*proposalAcceptGateLock
	maxPending int
}

type proposalAcceptGateLock struct {
	execMu    sync.Mutex
	pendingMu sync.Mutex
	pending   int
}

func newProposalAcceptGate(maxPending int) *proposalAcceptGate {
	return &proposalAcceptGate{
		locks:      map[uuid.UUID]*proposalAcceptGateLock{},
		maxPending: maxPending,
	}
}

func (g *proposalAcceptGate) WithDocument(documentID uuid.UUID, fn func() error) error {
	lock := g.lockFor(documentID)
	if !lock.tryReserve(g.maxPending) {
		return domain.NewRateLimitError(
			fmt.Sprintf("too many pending accept operations for document %s", documentID),
		)
	}
	defer lock.releaseReservation()

	lock.execMu.Lock()
	defer lock.execMu.Unlock()
	return fn()
}

func (g *proposalAcceptGate) pendingCount(documentID uuid.UUID) int {
	lock := g.lockFor(documentID)
	lock.pendingMu.Lock()
	defer lock.pendingMu.Unlock()
	return lock.pending
}

func (g *proposalAcceptGate) lockFor(documentID uuid.UUID) *proposalAcceptGateLock {
	g.mu.Lock()
	defer g.mu.Unlock()

	if lock, ok := g.locks[documentID]; ok {
		return lock
	}

	lock := &proposalAcceptGateLock{}
	g.locks[documentID] = lock
	return lock
}

func (l *proposalAcceptGateLock) tryReserve(maxPending int) bool {
	l.pendingMu.Lock()
	defer l.pendingMu.Unlock()

	if maxPending > 0 && l.pending >= maxPending {
		return false
	}
	l.pending++
	return true
}

func (l *proposalAcceptGateLock) releaseReservation() {
	l.pendingMu.Lock()
	defer l.pendingMu.Unlock()
	if l.pending > 0 {
		l.pending--
	}
}
