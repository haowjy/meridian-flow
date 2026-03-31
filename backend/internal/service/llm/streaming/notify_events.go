package streaming

import (
	"encoding/json"
	"strings"

	"meridian/internal/wsutil"
)

func broadcastTurnNotify(
	broadcaster wsutil.Broadcaster,
	projectID string,
	turnID string,
	event string,
	extra map[string]any,
) {
	if broadcaster == nil {
		return
	}
	projectID = strings.TrimSpace(projectID)
	turnID = strings.TrimSpace(turnID)
	if projectID == "" || turnID == "" || strings.TrimSpace(event) == "" {
		return
	}

	payload := map[string]any{"event": event}
	for k, v := range extra {
		payload[k] = v
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}

	broadcaster.BroadcastNotify(projectID, wsutil.Envelope{
		Op:       wsutil.OpInvalidate,
		Resource: &wsutil.Resource{Type: "turn", Id: turnID},
		Payload:  raw,
	})
}
