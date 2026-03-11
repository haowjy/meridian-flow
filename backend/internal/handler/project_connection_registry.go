package handler

import (
	"log/slog"
	"sync"
)

// ProjectBroadcaster is consumed by the proposal broadcaster to send JSON events
// to all connections for a project.
type ProjectBroadcaster interface {
	BroadcastToProject(projectID string, message []byte)
}

// ProjectConnectionRegistrar is consumed by the project WS handler to register/unregister
// connections as they connect and disconnect.
type ProjectConnectionRegistrar interface {
	Register(projectID, connectionID string, conn ProjectConnection)
	Unregister(connectionID string)
}

// ProjectConnectionRegistry combines project websocket registration and broadcast
// capabilities for handlers that need both behaviors.
type ProjectConnectionRegistry interface {
	ProjectBroadcaster
	ProjectConnectionRegistrar
}

// ProjectConnection represents a single project WS connection.
// No writeChan -- coder/websocket is concurrent-write-safe, so Send() calls
// conn.Write() directly.
type ProjectConnection interface {
	Send(data []byte) error
}

// InMemoryProjectConnectionRegistry satisfies both ProjectBroadcaster and ProjectConnectionRegistrar.
type InMemoryProjectConnectionRegistry struct {
	mu     sync.RWMutex
	logger *slog.Logger
	// connectionID -> registeredConn
	conns map[string]*registeredConn
}

type registeredConn struct {
	projectID string
	conn      ProjectConnection
}

func NewInMemoryProjectConnectionRegistry(logger *slog.Logger) *InMemoryProjectConnectionRegistry {
	if logger == nil {
		logger = slog.Default()
	}

	return &InMemoryProjectConnectionRegistry{
		logger: logger,
		conns:  make(map[string]*registeredConn),
	}
}

func (r *InMemoryProjectConnectionRegistry) Register(projectID, connectionID string, conn ProjectConnection) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.conns[connectionID] = &registeredConn{
		projectID: projectID,
		conn:      conn,
	}
}

func (r *InMemoryProjectConnectionRegistry) Unregister(connectionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.conns, connectionID)
}

func (r *InMemoryProjectConnectionRegistry) BroadcastToProject(projectID string, message []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for connectionID, registered := range r.conns {
		if registered == nil || registered.projectID != projectID || registered.conn == nil {
			continue
		}

		if err := registered.conn.Send(message); err != nil {
			r.logger.Warn("project connection broadcast send failed",
				"project_id", projectID,
				"connection_id", connectionID,
				"error", err,
			)
		}
	}
}
