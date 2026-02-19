package handler

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	serviceCollab "meridian/internal/service/collab"
)

const (
	// projectMaxDocSubscriptions is the max concurrent document subscriptions per project WS.
	projectMaxDocSubscriptions = 10
)

// projectDocSubscription tracks a single document subscription within a project websocket.
type projectDocSubscription struct {
	docID   string // canonical UUID string
	docUUID uuid.UUID
	session *serviceCollab.DocumentSession
	conn    *multiplexedConnection // adapter registered with broadcaster
}

// projectSubscriptionRegistry is connection-local state for document subscriptions.
type projectSubscriptionRegistry struct {
	mu    sync.Mutex
	subs  map[string]*projectDocSubscription // keyed by canonical document UUID string
	limit int
}

func newProjectSubscriptionRegistry(limit int) *projectSubscriptionRegistry {
	return &projectSubscriptionRegistry{
		subs:  make(map[string]*projectDocSubscription),
		limit: limit,
	}
}

func (r *projectSubscriptionRegistry) get(docID string) (*projectDocSubscription, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sub, ok := r.subs[docID]
	return sub, ok
}

func (r *projectSubscriptionRegistry) add(sub *projectDocSubscription) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.subs) >= r.limit {
		return fmt.Errorf("subscription limit exceeded (%d)", r.limit)
	}
	r.subs[sub.docID] = sub
	return nil
}

func (r *projectSubscriptionRegistry) remove(docID string) (*projectDocSubscription, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sub, ok := r.subs[docID]
	if ok {
		delete(r.subs, docID)
	}
	return sub, ok
}

// all returns a snapshot of all subscriptions (safe for iteration during cleanup).
func (r *projectSubscriptionRegistry) all() []*projectDocSubscription {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*projectDocSubscription, 0, len(r.subs))
	for _, sub := range r.subs {
		out = append(out, sub)
	}
	return out
}

// --- JSON protocol message types for project websocket ---

const (
	wsTypeDocSubscribe    = "doc:subscribe"
	wsTypeDocUnsubscribe  = "doc:unsubscribe"
	wsTypeDocSubscribed   = "doc:subscribed"
	wsTypeDocUnsubscribed = "doc:unsubscribed"
	wsTypeDocError        = "doc:error"
)

type docSubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docUnsubscribeCommand struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docSubscribedEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
}

type docUnsubscribedEvent struct {
	Type       string  `json:"type"`
	DocumentID string  `json:"documentId"`
	Reason     *string `json:"reason,omitempty"`
}

type docErrorEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}

// --- multiplexedConnection adapter ---

// multiplexedConnection wraps a project-level websocket connection to satisfy
// collabSvc.Connection for a single document subscription. Outbound binary frames
// are multiplexed with the document UUID prefix so the client can demux.
type multiplexedConnection struct {
	id     string
	parent *websocketDocumentConnection // shared project WS connection
}

func newMultiplexedConnection(parent *websocketDocumentConnection) *multiplexedConnection {
	return &multiplexedConnection{
		id:     uuid.NewString(),
		parent: parent,
	}
}

func (c *multiplexedConnection) ID() string {
	return c.id
}

// Send writes data through the parent project WS as-is.
// Broadcaster payloads are already multiplexed as [type][docUUID][payload].
func (c *multiplexedConnection) Send(data []byte) error {
	return c.parent.Send(data)
}

// --- subscription lifecycle helpers ---

// teardownSubscription cleans up a single document subscription: unsubscribe broadcaster,
// release session, remove from registry. Safe to call if not subscribed.
func (h *CollabHandler) teardownSubscription(
	ctx context.Context,
	documentID string,
	registry *projectSubscriptionRegistry,
) {
	sub, ok := registry.remove(documentID)
	if !ok {
		return
	}

	if sub.conn != nil {
		h.documentBroadcaster.Unsubscribe(documentID, sub.conn)
	}

	if sub.session != nil {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := h.sessionManager.Release(releaseCtx, documentID); err != nil {
			h.logger.Error("project ws session release failed",
				"document_id", documentID,
				"error", err,
			)
		}
	}
}

// cleanupProjectSubscriptions tears down all active subscriptions on connection close.
func (h *CollabHandler) cleanupProjectSubscriptions(
	ctx context.Context,
	registry *projectSubscriptionRegistry,
	projectID string,
	connectionID string,
) {
	for _, sub := range registry.all() {
		if sub.conn != nil {
			h.documentBroadcaster.Unsubscribe(sub.docID, sub.conn)
		}
		if sub.session != nil {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := h.sessionManager.Release(releaseCtx, sub.docID); err != nil {
				h.logger.Error("project ws cleanup session release failed",
					"project_id", projectID,
					"document_id", sub.docID,
					"connection_id", connectionID,
					"error", err,
				)
			}
			cancel()
		}
	}
}
