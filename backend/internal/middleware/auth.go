package middleware

import (
	"net/http"

	"meridian/internal/httputil"
)

// AuthMiddleware is a simple auth stub that sets a test user ID
// In Phase 2, this will be replaced with real Supabase auth
func AuthMiddleware(testUserID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// For now, just set a test user ID in the context
			// Later, this will validate JWT tokens from Supabase
			r = httputil.WithUserID(r, testUserID)
			next.ServeHTTP(w, r)
		})
	}
}

