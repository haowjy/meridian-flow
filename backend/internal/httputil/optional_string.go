package httputil

import (
	"bytes"
	"encoding/json"
)

// OptionalString tracks presence and value for JSON PATCH semantics (RFC 7396).
// This enables proper tri-state handling that Go's *string cannot express:
//   - Present=false: field absent from JSON (don't change)
//   - Present=true, Value=nil: field is JSON null (clear/set to NULL)
//   - Present=true, Value=&"": field is empty string
//   - Present=true, Value=&"text": field has value
type OptionalString struct {
	Present bool
	Value   *string
}

// UnmarshalJSON implements json.Unmarshaler.
// When this method is called, the field was present in the JSON.
func (o *OptionalString) UnmarshalJSON(data []byte) error {
	o.Present = true

	// Check for JSON null
	if string(bytes.TrimSpace(data)) == "null" {
		o.Value = nil
		return nil
	}

	// Parse as string
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	o.Value = &s
	return nil
}
