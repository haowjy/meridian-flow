package httputil

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// ParseJSON decodes JSON from the request body into the given destination.
// It limits the request body size to prevent abuse and provides clear error messages.
func ParseJSON(w http.ResponseWriter, r *http.Request, dest interface{}) error {
	// Limit request body to 10MB (requires w for proper 413 response)
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

	decoder := json.NewDecoder(r.Body)
	// Note: DisallowUnknownFields() is intentionally NOT used to allow flexible
	// map fields like request_params to accept arbitrary LLM provider parameters.
	// Validation is performed downstream via domain-specific validators.

	if err := decoder.Decode(dest); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}

	return nil
}
