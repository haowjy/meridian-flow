package smoke_test

import (
	"context"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	collabModels "meridian/internal/domain/models/collab"
	serviceCollab "meridian/internal/service/collab"
)

// testStore implements collab.DocumentStore minimally for smoke tests.
type testStore struct{}

func (s *testStore) LoadState(_ context.Context, _ string) ([]byte, error)   { return nil, nil }
func (s *testStore) SaveState(_ context.Context, _ string, _ []byte, _ string, _ string) error {
	return nil
}
func (s *testStore) SaveSnapshot(_ context.Context, _ string, _ []byte, _ string, _ *string, _ *string) (string, error) {
	return "", nil
}
func (s *testStore) ListSnapshots(_ context.Context, _ string, _, _ int) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}
func (s *testStore) GetSnapshot(_ context.Context, _ string) (*collabModels.SnapshotWithState, error) {
	return nil, nil
}
func (s *testStore) DeleteSnapshot(_ context.Context, _ string) error { return nil }
func (s *testStore) DeleteExpiredAutoSnapshots(_ context.Context, _ int) (int64, error) {
	return 0, nil
}

// testConn implements collab.Connection.
type testConn struct{ id string }

func (c *testConn) ID() string          { return c.id }
func (c *testConn) Send(_ []byte) error { return nil }

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func TestSubscriptionService_SubscribeIdempotent(t *testing.T) {
	logger := newLogger()
	sessionMgr := serviceCollab.NewDocumentSessionManager(&testStore{}, logger, 500)
	broadcaster := serviceCollab.NewInMemoryDocumentBroadcaster()
	svc := serviceCollab.NewSubscriptionService(sessionMgr, broadcaster, logger, 10)

	connID := "conn-1"
	docID := uuid.New().String()
	docUUID := uuid.MustParse(docID)

	// First subscribe
	result, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
		ConnectionID: connID, DocumentID: docID, DocumentUUID: docUUID,
		Conn: &testConn{id: "mux-1"},
	})
	if err != nil {
		t.Fatalf("first subscribe: %v", err)
	}
	if result.AlreadySubscribed {
		t.Fatal("expected AlreadySubscribed=false on first subscribe")
	}
	if result.Subscription.Session == nil {
		t.Fatal("expected non-nil session")
	}

	// Second subscribe (idempotent)
	result2, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
		ConnectionID: connID, DocumentID: docID, DocumentUUID: docUUID,
		Conn: &testConn{id: "mux-2"},
	})
	if err != nil {
		t.Fatalf("idempotent subscribe: %v", err)
	}
	if !result2.AlreadySubscribed {
		t.Fatal("expected AlreadySubscribed=true on second subscribe")
	}
	if result2.Subscription != result.Subscription {
		t.Fatal("expected same subscription pointer on idempotent subscribe")
	}
}

func TestSubscriptionService_LimitExceeded(t *testing.T) {
	logger := newLogger()
	sessionMgr := serviceCollab.NewDocumentSessionManager(&testStore{}, logger, 500)
	broadcaster := serviceCollab.NewInMemoryDocumentBroadcaster()
	svc := serviceCollab.NewSubscriptionService(sessionMgr, broadcaster, logger, 3)

	connID := "conn-1"
	for i := 0; i < 3; i++ {
		docID := uuid.New().String()
		_, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
			ConnectionID: connID, DocumentID: docID, DocumentUUID: uuid.MustParse(docID),
			Conn: &testConn{id: uuid.NewString()},
		})
		if err != nil {
			t.Fatalf("subscribe %d: %v", i, err)
		}
	}

	docID := uuid.New().String()
	_, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
		ConnectionID: connID, DocumentID: docID, DocumentUUID: uuid.MustParse(docID),
		Conn: &testConn{id: uuid.NewString()},
	})
	if err != serviceCollab.ErrSubscriptionLimitExceeded {
		t.Fatalf("expected ErrSubscriptionLimitExceeded, got: %v", err)
	}
}

func TestSubscriptionService_UnsubscribeAndResubscribe(t *testing.T) {
	logger := newLogger()
	sessionMgr := serviceCollab.NewDocumentSessionManager(&testStore{}, logger, 500)
	broadcaster := serviceCollab.NewInMemoryDocumentBroadcaster()
	svc := serviceCollab.NewSubscriptionService(sessionMgr, broadcaster, logger, 10)

	connID := "conn-1"
	docID := uuid.New().String()
	docUUID := uuid.MustParse(docID)

	_, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
		ConnectionID: connID, DocumentID: docID, DocumentUUID: docUUID,
		Conn: &testConn{id: "mux-1"},
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	if _, ok := svc.GetSubscription(connID, docID); !ok {
		t.Fatal("expected to find subscription")
	}

	svc.Unsubscribe(context.Background(), connID, docID)

	if _, ok := svc.GetSubscription(connID, docID); ok {
		t.Fatal("expected subscription gone after unsubscribe")
	}

	// Resubscribe
	result, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
		ConnectionID: connID, DocumentID: docID, DocumentUUID: docUUID,
		Conn: &testConn{id: "mux-2"},
	})
	if err != nil {
		t.Fatalf("resubscribe: %v", err)
	}
	if result.AlreadySubscribed {
		t.Fatal("expected AlreadySubscribed=false on resubscribe")
	}
}

func TestSubscriptionService_UnsubscribeAll(t *testing.T) {
	logger := newLogger()
	sessionMgr := serviceCollab.NewDocumentSessionManager(&testStore{}, logger, 500)
	broadcaster := serviceCollab.NewInMemoryDocumentBroadcaster()
	svc := serviceCollab.NewSubscriptionService(sessionMgr, broadcaster, logger, 10)

	connID := "conn-1"
	docIDs := make([]string, 3)
	for i := 0; i < 3; i++ {
		docID := uuid.New().String()
		docIDs[i] = docID
		_, err := svc.Subscribe(context.Background(), serviceCollab.SubscribeRequest{
			ConnectionID: connID, DocumentID: docID, DocumentUUID: uuid.MustParse(docID),
			Conn: &testConn{id: uuid.NewString()},
		})
		if err != nil {
			t.Fatalf("subscribe %d: %v", i, err)
		}
	}

	svc.UnsubscribeAll(context.Background(), connID)

	for _, docID := range docIDs {
		if _, ok := svc.GetSubscription(connID, docID); ok {
			t.Fatalf("expected subscription for %s gone after UnsubscribeAll", docID)
		}
	}
}
