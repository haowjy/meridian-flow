package collab

import (
	"fmt"
	"sync"

	collabSvc "meridian/internal/domain/services/collab"
)

// InMemoryDocumentBroadcaster is v1 broadcaster implementation for a single backend instance.
type InMemoryDocumentBroadcaster struct {
	mu          sync.RWMutex
	subscribers map[string]map[string]collabSvc.Connection // docID -> connID -> connection
}

// NewInMemoryDocumentBroadcaster creates a v1 in-process broadcaster.
func NewInMemoryDocumentBroadcaster() collabSvc.DocumentBroadcaster {
	return &InMemoryDocumentBroadcaster{
		subscribers: make(map[string]map[string]collabSvc.Connection),
	}
}

// Subscribe registers a connection to receive updates for the document.
func (b *InMemoryDocumentBroadcaster) Subscribe(docID string, conn collabSvc.Connection) error {
	if conn == nil {
		return fmt.Errorf("connection is required")
	}
	if docID == "" {
		return fmt.Errorf("document id is required")
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if _, ok := b.subscribers[docID]; !ok {
		b.subscribers[docID] = make(map[string]collabSvc.Connection)
	}
	b.subscribers[docID][conn.ID()] = conn
	return nil
}

// Unsubscribe removes a connection from the document channel.
func (b *InMemoryDocumentBroadcaster) Unsubscribe(docID string, conn collabSvc.Connection) {
	if conn == nil || docID == "" {
		return
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	docSubscribers, ok := b.subscribers[docID]
	if !ok {
		return
	}

	delete(docSubscribers, conn.ID())
	if len(docSubscribers) == 0 {
		delete(b.subscribers, docID)
	}
}

// Broadcast sends payload to all subscribers except an optional excluded sender.
func (b *InMemoryDocumentBroadcaster) Broadcast(docID string, update []byte, exclude collabSvc.Connection) {
	b.mu.RLock()
	docSubscribers, ok := b.subscribers[docID]
	if !ok {
		b.mu.RUnlock()
		return
	}

	// Copy references to avoid holding lock while sending on network transports.
	targets := make([]collabSvc.Connection, 0, len(docSubscribers))
	excludeID := ""
	if exclude != nil {
		excludeID = exclude.ID()
	}
	for connID, conn := range docSubscribers {
		if connID == excludeID {
			continue
		}
		targets = append(targets, conn)
	}
	b.mu.RUnlock()

	// Best-effort broadcast. Individual send failures are isolated to the target connection.
	for _, conn := range targets {
		if err := conn.Send(update); err != nil {
			b.Unsubscribe(docID, conn)
		}
	}
}
