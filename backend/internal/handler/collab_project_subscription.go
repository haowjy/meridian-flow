package handler

// --- JSON protocol message types for project websocket ---

const (
	wsTypeDocError         = "doc:error"
	wsTypeProjectConnected = "project:connected"
)

type docErrorEvent struct {
	Type       string `json:"type"`
	DocumentID string `json:"documentId"`
	Code       string `json:"code"`
	Message    string `json:"message"`
}
