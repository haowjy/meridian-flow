package optional

import (
	"bytes"
	"encoding/json"
)

// Optional tracks presence and value for JSON PATCH semantics (RFC 7396).
// Supports proper tri-state handling that Go's *T cannot express:
//   - Present=false: field absent from JSON (don't change)
//   - Present=true, Value=nil: field is JSON null (clear/set to NULL)
//   - Present=true, Value=&v: field has value
type Optional[T any] struct {
	Present bool
	Value   *T
}

// UnmarshalJSON implements json.Unmarshaler.
// When this method is called, the field was present in the JSON.
func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	o.Present = true

	// Check for JSON null
	if string(bytes.TrimSpace(data)) == "null" {
		o.Value = nil
		return nil
	}

	// Parse as T
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}
