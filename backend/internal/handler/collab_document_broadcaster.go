package handler

// DocumentBroadcaster sends binary data to all WebSocket connections for a document.
type DocumentBroadcaster interface {
	BroadcastToDocument(documentID string, data []byte)
}
