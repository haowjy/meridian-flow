package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	collabSvc "meridian/internal/domain/services/collab"
)

// --- Errors ---

// ErrSubscriptionLimitExceeded is returned when a connection has reached its
// maximum concurrent document subscriptions.
var ErrSubscriptionLimitExceeded = errors.New("subscription limit exceeded")

// --- Types ---

// Subscription tracks a single document subscription within a connection.
type Subscription struct {
	DocID   string
	DocUUID uuid.UUID
	Session *DocumentSession
	Conn    collabSvc.Connection // multiplexed connection registered with broadcaster
}

// SubscribeRequest captures the inputs for subscribing to a document.
type SubscribeRequest struct {
	ConnectionID string
	DocumentID   string
	DocumentUUID uuid.UUID
	Conn         collabSvc.Connection // multiplexed connection adapter
}

// SubscribeResult captures the outcome of a subscription attempt.
type SubscribeResult struct {
	Subscription      *Subscription
	AlreadySubscribed bool // true = idempotent re-ack, no new acquire
}

// --- Service ---

// SessionLifecycle is the narrow interface for session acquire/release (ISP).
// Decouples the SubscriptionService from the concrete DocumentSessionManager.
type SessionLifecycle interface {
	Acquire(ctx context.Context, docID string) (*DocumentSession, error)
	Release(ctx context.Context, docID string) error
}

// SubscriptionService owns the document subscription lifecycle: idempotency
// checks, per-connection limits, session acquire/release, and broadcaster
// subscribe/unsubscribe. The handler delegates to this service instead of
// managing subscriptions directly.
type SubscriptionService struct {
	sessionManager      SessionLifecycle
	documentBroadcaster collabSvc.DocumentBroadcaster
	logger              *slog.Logger
	maxPerConnection    int

	mu          sync.Mutex
	connections map[string]*subscriptionSet // connectionID -> per-connection state
}

// subscriptionSet tracks document subscriptions for a single WS connection.
type subscriptionSet struct {
	subs map[string]*Subscription // docID -> subscription
}

func NewSubscriptionService(
	sessionManager SessionLifecycle,
	documentBroadcaster collabSvc.DocumentBroadcaster,
	logger *slog.Logger,
	maxPerConnection int,
) *SubscriptionService {
	return &SubscriptionService{
		sessionManager:      sessionManager,
		documentBroadcaster: documentBroadcaster,
		logger:              logger,
		maxPerConnection:    maxPerConnection,
		connections:         make(map[string]*subscriptionSet),
	}
}

// Subscribe acquires a document session and subscribes to the broadcaster.
//
// Idempotent: if the connection already subscribes to the same document,
// returns the existing subscription with AlreadySubscribed=true (no re-acquire).
//
// On any failure after partial setup, the service automatically rolls back
// (releases session, removes from tracking).
func (s *SubscriptionService) Subscribe(ctx context.Context, req SubscribeRequest) (*SubscribeResult, error) {
	s.mu.Lock()

	cs, ok := s.connections[req.ConnectionID]
	if !ok {
		cs = &subscriptionSet{subs: make(map[string]*Subscription)}
		s.connections[req.ConnectionID] = cs
	}

	// Idempotent: already subscribed -> return existing
	if existing, alreadySubscribed := cs.subs[req.DocumentID]; alreadySubscribed {
		s.mu.Unlock()
		return &SubscribeResult{
			Subscription:      existing,
			AlreadySubscribed: true,
		}, nil
	}

	// Enforce per-connection limit
	if len(cs.subs) >= s.maxPerConnection {
		s.mu.Unlock()
		return nil, ErrSubscriptionLimitExceeded
	}

	// Reserve slot before releasing lock (prevents concurrent subscribes
	// from exceeding the limit). Session/conn are set below.
	sub := &Subscription{
		DocID:   req.DocumentID,
		DocUUID: req.DocumentUUID,
	}
	cs.subs[req.DocumentID] = sub
	s.mu.Unlock()

	// Acquire session (outside lock — may involve DB I/O)
	session, err := s.sessionManager.Acquire(ctx, req.DocumentID)
	if err != nil {
		s.removeSub(req.ConnectionID, req.DocumentID)
		return nil, fmt.Errorf("session acquire failed: %w", err)
	}
	sub.Session = session

	// Subscribe to broadcaster
	sub.Conn = req.Conn
	if err := s.documentBroadcaster.Subscribe(req.DocumentID, req.Conn); err != nil {
		// Rollback: release session and remove from tracking
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if relErr := s.sessionManager.Release(releaseCtx, req.DocumentID); relErr != nil {
			s.logger.Error("session release failed after broadcaster subscribe error",
				"document_id", req.DocumentID,
				"error", relErr,
			)
		}
		s.removeSub(req.ConnectionID, req.DocumentID)
		return nil, fmt.Errorf("broadcaster subscribe failed: %w", err)
	}

	return &SubscribeResult{
		Subscription:      sub,
		AlreadySubscribed: false,
	}, nil
}

// Unsubscribe tears down a single document subscription: unsubscribes the
// broadcaster, releases the session, and removes from tracking.
// Safe to call if the document is not subscribed.
func (s *SubscriptionService) Unsubscribe(ctx context.Context, connectionID string, documentID string) {
	sub := s.removeAndGet(connectionID, documentID)
	if sub == nil {
		return
	}
	s.teardown(ctx, documentID, sub)
}

// UnsubscribeAll tears down all document subscriptions for a connection.
// Called on connection close to replace the handler's manual cleanup loop.
func (s *SubscriptionService) UnsubscribeAll(ctx context.Context, connectionID string) {
	s.mu.Lock()
	cs, ok := s.connections[connectionID]
	if !ok {
		s.mu.Unlock()
		return
	}
	// Snapshot and remove entire connection atomically
	subs := make([]*Subscription, 0, len(cs.subs))
	for _, sub := range cs.subs {
		subs = append(subs, sub)
	}
	delete(s.connections, connectionID)
	s.mu.Unlock()

	for _, sub := range subs {
		s.teardown(ctx, sub.DocID, sub)
	}
}

// GetSubscription returns the subscription for a document on a connection.
// Used by the handler for binary message routing and proposal commands.
func (s *SubscriptionService) GetSubscription(connectionID string, documentID string) (*Subscription, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cs, ok := s.connections[connectionID]
	if !ok {
		return nil, false
	}
	sub, ok := cs.subs[documentID]
	return sub, ok
}

// MaxPerConnection returns the configured subscription limit.
func (s *SubscriptionService) MaxPerConnection() int {
	return s.maxPerConnection
}

// --- internal helpers ---

// removeSub removes a subscription from tracking without teardown.
func (s *SubscriptionService) removeSub(connectionID, documentID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cs, ok := s.connections[connectionID]
	if !ok {
		return
	}
	delete(cs.subs, documentID)
	if len(cs.subs) == 0 {
		delete(s.connections, connectionID)
	}
}

// removeAndGet atomically removes and returns a subscription for teardown.
func (s *SubscriptionService) removeAndGet(connectionID, documentID string) *Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	cs, ok := s.connections[connectionID]
	if !ok {
		return nil
	}
	sub, ok := cs.subs[documentID]
	if !ok {
		return nil
	}
	delete(cs.subs, documentID)
	if len(cs.subs) == 0 {
		delete(s.connections, connectionID)
	}
	return sub
}

// teardown cleans up broadcaster subscription and session for a removed subscription.
func (s *SubscriptionService) teardown(ctx context.Context, documentID string, sub *Subscription) {
	if sub.Conn != nil {
		s.documentBroadcaster.Unsubscribe(documentID, sub.Conn)
	}

	if sub.Session != nil {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.sessionManager.Release(releaseCtx, documentID); err != nil {
			s.logger.Error("session release failed",
				"document_id", documentID,
				"error", err,
			)
		}
	}
}
