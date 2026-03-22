package httputil

import (
	"context"
	"net/http"

	authdomain "meridian/internal/domain/auth"
)

// Context key type to avoid collisions
type contextKey string

const (
	userIDKey     contextKey = "userID"
	authClaimsKey contextKey = "authClaims"
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

// WithAuthClaims adds validated auth claims to the request context.
func WithAuthClaims(r *http.Request, claims *authdomain.AuthClaims) *http.Request {
	ctx := context.WithValue(r.Context(), authClaimsKey, claims)
	return r.WithContext(ctx)
}

// GetAuthClaims retrieves auth claims from context, returns nil if unavailable.
func GetAuthClaims(r *http.Request) *authdomain.AuthClaims {
	claims, _ := r.Context().Value(authClaimsKey).(*authdomain.AuthClaims)
	return claims
}
