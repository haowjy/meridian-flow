package handler

import (
	"encoding/json"
	"strings"

	"meridian/internal/wsutil"
)

// DocNotifier emits document/proposal invalidation events to all project doc WS connections.
type DocNotifier interface {
	NotifyProposal(projectID string, proposalID string, event string, documentID string)
	NotifyDocument(projectID string, documentID string, event string)
	NotifyDocumentError(projectID string, documentID string, code string, message string)
}

type docNotifierImpl struct {
	broadcaster wsutil.Broadcaster
}

var _ DocNotifier = (*docNotifierImpl)(nil)

func NewDocNotifier(broadcaster wsutil.Broadcaster) DocNotifier {
	return &docNotifierImpl{broadcaster: broadcaster}
}

func (n *docNotifierImpl) NotifyProposal(projectID string, proposalID string, event string, documentID string) {
	n.broadcast(projectID, "proposal", proposalID, struct {
		Event      string `json:"event"`
		DocumentID string `json:"documentId"`
	}{
		Event:      strings.TrimSpace(event),
		DocumentID: strings.TrimSpace(documentID),
	})
}

func (n *docNotifierImpl) NotifyDocument(projectID string, documentID string, event string) {
	n.broadcast(projectID, "document", documentID, struct {
		Event string `json:"event"`
	}{
		Event: strings.TrimSpace(event),
	})
}

func (n *docNotifierImpl) NotifyDocumentError(projectID string, documentID string, code string, message string) {
	n.broadcast(projectID, "document", documentID, struct {
		Event   string `json:"event"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}{
		Event:   "error",
		Code:    strings.TrimSpace(code),
		Message: strings.TrimSpace(message),
	})
}

func (n *docNotifierImpl) broadcast(projectID string, resourceType string, resourceID string, payload any) {
	projectID = strings.TrimSpace(projectID)
	resourceType = strings.TrimSpace(resourceType)
	resourceID = strings.TrimSpace(resourceID)
	if n.broadcaster == nil || projectID == "" || resourceType == "" || resourceID == "" {
		return
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return
	}

	n.broadcaster.BroadcastNotify(projectID, wsutil.Envelope{
		Kind: wsutil.KindNotify,
		Op:   wsutil.OpInvalidate,
		Resource: &wsutil.Resource{
			Type: resourceType,
			Id:   resourceID,
		},
		Payload: payloadBytes,
	})
}
