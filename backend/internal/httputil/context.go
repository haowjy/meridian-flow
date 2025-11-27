package httputil

import (
	"context"
	"net/http"
)

// Context key type to avoid collisions
type contextKey string

const (
	userIDKey contextKey = "userID"
)

// WithUserID adds userID to the request context
func WithUserID(r *http.Request, userID string) *http.Request {
	ctx := context.WithValue(r.Context(), userIDKey, userID)
	return r.WithContext(ctx)
}

// GetUserID retrieves userID from context, returns empty string if not found
func GetUserID(r *http.Request) string {
	userID, _ := r.Context().Value(userIDKey).(string)
	return userID
}
