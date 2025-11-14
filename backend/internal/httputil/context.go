package httputil

import (
	"context"
	"net/http"
)

// Context key type to avoid collisions
type contextKey string

const (
	userIDKey    contextKey = "userID"
	projectIDKey contextKey = "projectID"
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

// WithProjectID adds projectID to the request context
func WithProjectID(r *http.Request, projectID string) *http.Request {
	ctx := context.WithValue(r.Context(), projectIDKey, projectID)
	return r.WithContext(ctx)
}

// GetProjectID retrieves projectID from context, returns empty string if not found
func GetProjectID(r *http.Request) string {
	projectID, _ := r.Context().Value(projectIDKey).(string)
	return projectID
}
