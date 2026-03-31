package handler

import "encoding/json"

// isJSONMessage returns true if the raw bytes look like a JSON object.
func isJSONMessage(raw []byte) bool {
	return len(raw) > 0 && raw[0] == '{'
}

// tryParseTypedMessage attempts to unmarshal a JSON message type field.
// Returns the type string and true if the message is valid JSON with a type field.
func tryParseTypedMessage(raw []byte) (string, bool) {
	if !isJSONMessage(raw) {
		return "", false
	}
	var typed collabTypedMessage
	if err := json.Unmarshal(raw, &typed); err != nil {
		return "", false
	}
	return typed.Type, true
}
