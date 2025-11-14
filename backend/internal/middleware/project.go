package middleware

import (
	"net/http"

	"meridian/internal/httputil"
)

// ProjectMiddleware is a simple stub that sets a test project ID
// In Phase 2, this will determine project from user context
func ProjectMiddleware(testProjectID string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// For now, just set a test project ID in the context
			// Later, this will be determined from user's projects
			r = httputil.WithProjectID(r, testProjectID)
			next.ServeHTTP(w, r)
		})
	}
}
