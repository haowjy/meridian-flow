package auth

import "meridian/internal/domain/models"

// JWTVerifier defines the interface for JWT token verification.
// This abstraction allows for different JWT verification implementations
// while keeping the middleware agnostic to the verification details.
type JWTVerifier interface {
	// VerifyToken validates a JWT token string and returns the parsed claims.
	// Returns an error if the token is invalid, expired, or has an invalid signature.
	VerifyToken(tokenString string) (*models.SupabaseClaims, error)

	// Close releases any resources held by the verifier (e.g., HTTP connections for JWKS).
	// Should be called when the verifier is no longer needed.
	Close() error
}
