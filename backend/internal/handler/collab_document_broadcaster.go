package handler

// DocumentSyncBroadcaster sends document sync updates and lifecycle signals
// over doc websocket subscriptions.
type DocumentSyncBroadcaster interface {
	BroadcastYjsUpdate(documentID string, update []byte)
	BroadcastDocumentRestored(documentID string)
	HasActiveSubscribers(documentID string) bool
}
