package middleware

import (
	"net/http"
	"strings"

	"meridian/internal/auth"
	"meridian/internal/httputil"
)

// AuthMiddleware validates JWT tokens from Supabase Auth.
// It extracts the Bearer token from the Authorization header, verifies it,
// and injects the user ID into the request context.
//
// The /health endpoint is excluded from authentication to allow
// load balancers and monitoring tools to check server health.
func AuthMiddleware(
	jwtVerifier auth.JWTVerifier,
	isIdentityBlocked func(string, string) bool,
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip auth for health check and collab websocket entrypoints.
			// Collab websocket uses JWT-in-first-message instead of Authorization header.
			if r.URL.Path == "/health" ||
				(r.Method == http.MethodPost && r.URL.Path == "/api/billing/webhooks/stripe") ||
				strings.HasPrefix(r.URL.Path, "/ws/projects/") ||
				strings.HasPrefix(r.URL.Path, "/ws/documents/") {
				next.ServeHTTP(w, r)
				return
			}

			// Extract Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				httputil.RespondError(w, http.StatusUnauthorized, "Missing authorization header")
				return
			}

			// Parse Bearer token
			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				httputil.RespondError(w, http.StatusUnauthorized, "Invalid authorization header format")
				return
			}

			tokenString := parts[1]

			// Verify token and extract claims
			claims, err := jwtVerifier.VerifyToken(tokenString)
			if err != nil {
				// Generic error message for security (don't reveal token details)
				httputil.RespondError(w, http.StatusUnauthorized, "Invalid or expired token")
				return
			}

			userID := claims.GetUserID()
			if isIdentityBlocked != nil && isIdentityBlocked(userID, claims.Email) {
				httputil.RespondError(w, http.StatusForbidden, "Access denied")
				return
			}

			// Inject user ID into request context
			r = httputil.WithUserID(r, userID)
			r = httputil.WithAuthClaims(r, claims)
			next.ServeHTTP(w, r)
		})
	}
}
