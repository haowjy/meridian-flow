package handler

import (
	"github.com/google/uuid"
)

// --- JSON protocol message types for project websocket ---

const (
	wsTypeDocSubscribe     = "doc:subscribe"
	wsTypeDocUnsubscribe   = "doc:unsubscribe"
	wsTypeDocSubscribed    = "doc:subscribed"
	wsTypeDocUnsubscribed  = "doc:unsubscribed"
	wsTypeDocError         = "doc:error"
	wsTypeProjectConnected = "project:connected"
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
