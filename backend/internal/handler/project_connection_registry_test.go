package handler

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type recordingProjectConnection struct {
	mu       sync.Mutex
	messages [][]byte
	sendErr  error
}

func (c *recordingProjectConnection) Send(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.sendErr != nil {
		return c.sendErr
	}

	copied := append([]byte(nil), data...)
	c.messages = append(c.messages, copied)
	return nil
}

func (c *recordingProjectConnection) messagesSnapshot() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([][]byte, 0, len(c.messages))
	for _, msg := range c.messages {
		out = append(out, append([]byte(nil), msg...))
	}
	return out
}

func TestProjectConnectionRegistry_BroadcastRoutesByProjectAndSkipsNilConnections(t *testing.T) {
	registry := NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil)))

	projectA := "project-a"
	projectB := "project-b"

	connA1 := &recordingProjectConnection{}
	connA2 := &recordingProjectConnection{}
	connB := &recordingProjectConnection{}
	connErr := &recordingProjectConnection{sendErr: errors.New("write failed")}

	registry.Register(projectA, "a1", connA1)
	registry.Register(projectA, "a2", connA2)
	registry.Register(projectA, "a-error", connErr)
	registry.Register(projectA, "a-nil", nil)
	registry.Register(projectB, "b1", connB)

	// Cover the defensive nil registered-connection branch.
	registry.conns["dangling"] = nil

	firstMessage := []byte(`{"type":"proposal:statusChanged","seq":1}`)
	registry.BroadcastToProject(projectA, firstMessage)

	if got := len(connA1.messagesSnapshot()); got != 1 {
		t.Fatalf("expected project A conn a1 to receive 1 message, got %d", got)
	}
	if got := len(connA2.messagesSnapshot()); got != 1 {
		t.Fatalf("expected project A conn a2 to receive 1 message, got %d", got)
	}
	if got := len(connB.messagesSnapshot()); got != 0 {
		t.Fatalf("expected project B conn to receive 0 messages from project A broadcast, got %d", got)
	}

	registry.Unregister("a2")
	registry.Unregister("unknown-connection-id")

	secondMessage := []byte(`{"type":"proposal:statusChanged","seq":2}`)
	registry.BroadcastToProject(projectA, secondMessage)

	messagesA1 := connA1.messagesSnapshot()
	if got := len(messagesA1); got != 2 {
		t.Fatalf("expected project A conn a1 to receive 2 messages, got %d", got)
	}
	if string(messagesA1[1]) != string(secondMessage) {
		t.Fatalf("unexpected second message on conn a1: got %q want %q", string(messagesA1[1]), string(secondMessage))
	}

	if got := len(connA2.messagesSnapshot()); got != 1 {
		t.Fatalf("expected unregistered conn a2 to stay at 1 message, got %d", got)
	}
	if got := len(connB.messagesSnapshot()); got != 0 {
		t.Fatalf("expected project B conn to still have 0 messages, got %d", got)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectConnectionRegistry_RegisterReplacesExistingConnectionID(t *testing.T) {
	registry := NewInMemoryProjectConnectionRegistry(nil)

	originalConn := &recordingProjectConnection{}
	replacementConn := &recordingProjectConnection{}

	registry.Register("project-a", "shared-connection", originalConn)
	registry.Register("project-a", "shared-connection", replacementConn)

	registry.BroadcastToProject("project-a", []byte("payload"))

	if got := len(originalConn.messagesSnapshot()); got != 0 {
		t.Fatalf("expected replaced connection to receive 0 messages, got %d", got)
	}
	if got := len(replacementConn.messagesSnapshot()); got != 1 {
		t.Fatalf("expected replacement connection to receive 1 message, got %d", got)
	}
}

// [unit-tester:dispose] verification -- safe to delete after passing
func TestProjectConnectionRegistry_BroadcastToProject_NoRegisteredTargetsIsNoop(t *testing.T) {
	registry := NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil)))

	otherProjectConn := &recordingProjectConnection{}
	registry.Register("other-project", "other-1", otherProjectConn)

	registry.BroadcastToProject("missing-project", []byte("payload"))

	if got := len(otherProjectConn.messagesSnapshot()); got != 0 {
		t.Fatalf("expected unrelated project connection to receive 0 messages, got %d", got)
	}
}

func TestProjectConnectionRegistry_ConcurrentRegisterUnregisterAndBroadcast(t *testing.T) {
	registry := NewInMemoryProjectConnectionRegistry(slog.New(slog.NewTextHandler(io.Discard, nil)))

	const (
		workers    = 12
		iterations = 200
	)

	projectID := "project-concurrent"
	otherID := "other-project"

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		workerID := i
		wg.Add(1)

		go func() {
			defer wg.Done()

			conn := &recordingProjectConnection{}
			connectionID := fmt.Sprintf("conn-%d", workerID)

			for j := 0; j < iterations; j++ {
				registry.Register(projectID, connectionID, conn)
				registry.BroadcastToProject(projectID, []byte("project"))
				registry.BroadcastToProject(otherID, []byte("other"))
				registry.Unregister(connectionID)
			}
		}()
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("concurrent register/unregister/broadcast did not complete")
	}

	finalConn := &recordingProjectConnection{}
	registry.Register(projectID, "final", finalConn)
	registry.BroadcastToProject(projectID, []byte("final"))

	if got := len(finalConn.messagesSnapshot()); got != 1 {
		t.Fatalf("expected final connection to receive one message after concurrent activity, got %d", got)
	}
}
