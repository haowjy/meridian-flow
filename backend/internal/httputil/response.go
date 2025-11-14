package httputil

import (
	"encoding/json"
	"net/http"
)

// RespondJSON writes a JSON response with the given status code.
// It handles encoding errors safely by marshaling first, preventing
// partial responses if encoding fails after headers are sent.
func RespondJSON(w http.ResponseWriter, status int, data interface{}) {
	payload, err := json.Marshal(data)
	if err != nil {
		// Encoding failed - return 500 instead
		RespondError(w, http.StatusInternalServerError, "failed to encode response")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(payload)
}

// ProblemDetail represents an RFC 7807 Problem Details response
type ProblemDetail struct {
	Type     string                 `json:"type"`
	Title    string                 `json:"title"`
	Status   int                    `json:"status"`
	Detail   string                 `json:"detail,omitempty"`
	Instance string                 `json:"instance,omitempty"`
	Extra    map[string]interface{} `json:"-"`
}

// MarshalJSON implements custom JSON marshaling to include Extra fields at top level
func (p ProblemDetail) MarshalJSON() ([]byte, error) {
	// Create base map
	m := map[string]interface{}{
		"type":   p.Type,
		"title":  p.Title,
		"status": p.Status,
	}

	if p.Detail != "" {
		m["detail"] = p.Detail
	}
	if p.Instance != "" {
		m["instance"] = p.Instance
	}

	// Add extra fields
	for k, v := range p.Extra {
		m[k] = v
	}

	return json.Marshal(m)
}

// RespondError writes an RFC 7807 Problem Details error response
func RespondError(w http.ResponseWriter, status int, detail string) {
	problem := ProblemDetail{
		Type:   errorTypeFromStatus(status),
		Title:  http.StatusText(status),
		Status: status,
		Detail: detail,
	}

	payload, err := json.Marshal(problem)
	if err != nil {
		// Fallback to plain text if JSON encoding fails
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal server error"))
		return
	}

	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	w.Write(payload)
}

// RespondErrorWithExtras writes an RFC 7807 error with additional fields
func RespondErrorWithExtras(w http.ResponseWriter, status int, detail string, extras map[string]interface{}) {
	problem := ProblemDetail{
		Type:   errorTypeFromStatus(status),
		Title:  http.StatusText(status),
		Status: status,
		Detail: detail,
		Extra:  extras,
	}

	payload, err := json.Marshal(problem)
	if err != nil {
		// Fallback to plain text if JSON encoding fails
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal server error"))
		return
	}

	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	w.Write(payload)
}

// errorTypeFromStatus returns the RFC 7807 type URI for a status code
func errorTypeFromStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.1"
	case http.StatusUnauthorized:
		return "https://datatracker.ietf.org/doc/html/rfc7235#section-3.1"
	case http.StatusForbidden:
		return "https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.3"
	case http.StatusNotFound:
		return "https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.4"
	case http.StatusConflict:
		return "https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.8"
	case http.StatusInternalServerError:
		return "https://datatracker.ietf.org/doc/html/rfc7231#section-6.6.1"
	default:
		return "about:blank"
	}
}
