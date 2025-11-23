package sse

import (
	"fmt"
	"net/http"
)

// SSEKeepAliveWriter implements KeepAliveWriter for SSE connections
// Writes SSE comment lines (: keepalive) to maintain the connection
type SSEKeepAliveWriter struct {
	w        http.ResponseWriter
	flusher  http.Flusher
	turnID   string
	clientID string
}

// NewSSEKeepAliveWriter creates a new SSE keep-alive writer
func NewSSEKeepAliveWriter(
	w http.ResponseWriter,
	flusher http.Flusher,
	turnID string,
	clientID string,
) *SSEKeepAliveWriter {
	return &SSEKeepAliveWriter{
		w:        w,
		flusher:  flusher,
		turnID:   turnID,
		clientID: clientID,
	}
}

// WriteKeepAlive writes an SSE comment (: keepalive\n\n) and flushes
// Returns error if connection is closed or write fails
func (s *SSEKeepAliveWriter) WriteKeepAlive() error {
	// Write SSE comment format: ": keepalive\n\n"
	// SSE spec: Lines starting with : are comments (ignored by client)
	if _, err := fmt.Fprintf(s.w, ": keepalive\n\n"); err != nil {
		return fmt.Errorf("write keepalive failed: %w", err)
	}

	// Flush buffered data to client
	s.flusher.Flush()

	// Health check: Attempt zero-byte write to detect closed connections
	// If connection is closed, this will return an error
	if _, err := s.w.Write([]byte{}); err != nil {
		return fmt.Errorf("connection closed: %w", err)
	}

	return nil
}
